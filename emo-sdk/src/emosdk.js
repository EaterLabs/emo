// @flow
const mkdirp = require("./utils").mkdirp;
const yaml = require("yaml");
const {Parse} = require("unzipper");
const {promises, createWriteStream, createReadStream} = require('fs');
const fs = promises;
const {build, Task} = require("@eater/asbest");
const fetch = require("node-fetch");
const os = require("os");
const {MINECRAFT_MANIFEST_URL, ASSESTS_HOST_URL} = require("./urls");
const path = require("path");
const {Forge} = require("./forge");
const {Auth} = require("./mojang/auth");
const {Config} = require("./config");

type MinecraftInstallConfig = {
  name: string;
  minecraftVersion: string;
  forgeVersion: ?string;
  path: string;
  mode: "client" | "server";
};

type MinecraftStartConfig = {
  pwd: string;
  program: string;
  args: Array<string>;
}

class EmoSDK {
  workspace: string;
  auth: Auth;
  config: Config;

  constructor(workspace: string) {
    this.workspace = workspace;
    this.forge = new Forge();
    this.config = {};
  }

  async init() {
    await mkdirp(this.workspace);
    let configObj = {};

    try {
      const config = await fs.readFile(this.workspace + '/config.json');
      configObj = JSON.parse(config.toString('utf-8'));
    } catch (e) {
      if (e.code !== 'ENOENT') {
        throw e;
      }
    }

    this.config = new Config(configObj);
    await this.save();

    this.auth = new Auth(this.config.getClientToken());
  }

  resolveRoleList(list) {
    return list.reduce((aggr, item) => {
      if (typeof item === 'string') {
        aggr.push(item);
        return aggr;
      }

      if (!this.resolveMinecraftRules(item.rules)) {
        return aggr;
      }

      return aggr.concat(Array.isArray(item.value) ? item.value : [item.value]);
    }, []);
  }

  async refreshAccount(accountId: string) {
    let account = this.config.getAccount(accountId);

    if (!account) {
      throw new Error(`Can't find account with id '${accountId}'`);
    }

    if (await this.auth.validate(account.accessToken)) {
      return account;
    }

    account = await this.auth.refresh(account.accessToken);
    this.config.addAccount(account);
    await this.save();

    return account;
  }

  async getMinecraftStartCommand(profileId: string, accountId: ?string): MinecraftStartConfig {
    let profile = this.config.getProfile(profileId);

    if (!profile) {
      throw new Error(`Can't find profile with id '${profileId}'`);
    }

    if (profile.mode === 'client') {
      return await this.getMinecraftClientStartCommand(profileId, accountId)
    } else {
      return await this.getMinecraftServerStartCommand(profileId);
    }
  }

  async getMinecraftServerStartCommand(profileId): MinecraftStartConfig {
    let profile = this.config.getProfile(profileId);

    if (!profile) {
      throw new Error(`Can't find profile with id '${profileId}'`);
    }

    let minecraftJar = 'minecraft.jar';

    if (profile.forgeVersion) {
      minecraftJar = 'forge.jar';
    }

    return {
      pwd: profile.path,
      program: 'java',
      args: ['-jar', minecraftJar, 'nogui']
    }
  }

  async getMinecraftClientStartCommand(profileId: string, accountId: ?string): MinecraftStartConfig {
    let emoProfile = {};
    let manifest = {};

    let profile = this.config.getProfile(profileId);

    if (!profile) {
      throw new Error(`Can't find profile with id '${profileId}'`);
    }

    if (!accountId) {
      let account = this.config.getSelectedAccount();

      if (!account) {
        throw new Error('No selected account to start Minecraft with');
      }

      accountId = account.id;
    }

    let location = profile.path;
    let authInfo = await this.refreshAccount(accountId);

    try {
      const profile = await fs.readFile(location + '/emo.client.yml', 'utf-8');
      manifest = JSON.parse(await fs.readFile(location + '/manifest.json', 'utf-8'));
    } catch (e) {
      throw new Error("No or corrupt profile found at: " + location)
    }

    let classpath = manifest.libraries.reduce((aggr, item) => {
      if (!this.resolveMinecraftRules(item.rules)) {
        return aggr;
      }

      if (item.downloads.artifact) {
        aggr.push(path.join('libraries', item.downloads.artifact.path));
      }

      return aggr;
    }, []);

    if (emoProfile.forge) {
      classpath = classpath.concat(emoProfile.forge.libraries);
    }

    let templateVars = {};
    Object.assign(
      templateVars,
      {
        classpath: classpath.concat(['minecraft.jar']).join(':'),
        user_type: 'mojang',
        auth_uuid: authInfo.id,
        auth_player_name: authInfo.name,
        auth_access_token: authInfo.accessToken
      },
      emoProfile.vars
    );

    let mainClass = manifest.mainClass;

    let gameArguments = [];
    let jvmArguments = [
      '-Djava.library.path=${natives_directory}',
      '-Dminecraft.launcher.brand=${launcher_name}',
      '-Dminecraft.launcher.version=${launcher_version}',
      '-cp',
      '${classpath}'
    ];

    if (manifest.arguments) {
      gameArguments = this.resolveRoleList(manifest.arguments.game);
      jvmArguments = this.resolveRoleList(manifest.arguments.jvm);
    } else if (manifest.minecraftArguments) {
      gameArguments = manifest.minecraftArguments.split(/\s+/g);
    }

    if (emoProfile.forge) {
      mainClass = emoProfile.forge.mainClass;
      gameArguments = emoProfile.forge.minecraftArguments.split(/\s+/g)
    }

    let args = jvmArguments
      .concat([mainClass])
      .concat(gameArguments)
      .map(arg => EmoSDK.renderTemplateString(arg, templateVars));

    return {
      pwd: profile.path,
      program: 'java',
      args
    };
  }

  getMinecraftInstallTask(config: MinecraftInstallConfig): Task {
    async function exists(path) {
      try {
        await fs.stat(path)
      } catch (e) {
        return false;
      }
      return true;
    }

    const location = config.path;
    let version = config.minecraftVersion;
    let forgeVersion = config.forgeVersion;

    let steps = [
      this.getMinecraftVersionsManifestTask()
    ];

    if (config.forgeVersion) {
      steps.push({
        description: 'Fetching Forge versions manifest',
        action: async ({state}) => {
          let q = state.versionManifest.versions.find((versionManifest) => versionManifest.id === version);
          if (config.minecraftVersion === 'latest-snapshot' || (q && q.type === 'snapshot')) {
            throw new Error("Can't use Forge on snapshot releases of Minecraft");
          }

          if (config.forgeVersion === 'recommend' && config.minecraftVersion === 'latest') {
            let ver = await this.forge.getRecommendedVersion();

            if (!ver) {
              throw new Error("Can't find recommend version for forge");
            }

            version = ver.minecraftVersion;
            forgeVersion = ver.forgeVersion;
            state.minecraftVersionPreselected = version;

            return;
          }

          if (config.forgeVersion === 'recommend' || config.forgeVersion === 'latest') {
            if (config.minecraftVersion === 'latest') {
              version = state.versionManifest.latest.release;
            }

            let ver = await (config.forgeVersion === 'recommend' ? this.forge.getRecommendedForVersion(version) : this.forge.getLatestForVersion(version));

            if (!ver) {
              throw new Error(`Can't find ${config.forgeVersion} for Minecraft version ${version}`);
            }

            version = ver.minecraftVersion;
            forgeVersion = ver.forgeVersion;
          }
        }
      })
    }

    steps.push(
      {
        description: `Fetching Minecraft version '${version}' manifest`,
        action: async ({controller, state}) => {
          if (state.minecraftVersionPreselected) {
            console.log(' > Selected version: ' + version);
          } else if (config.minecraftVersion === 'latest') {
            version = state.versionManifest.latest.release;
            console.log(' > Selected version: ' + version);
          } else if (config.minecraftVersion === 'latest-snapshot') {
            version = state.versionManifest.latest.snapshot;
            console.log(' > Selected version: ' + version);
          }

          const versionManifest = state.versionManifest.versions.find((versionManifest) => versionManifest.id === version);

          if (versionManifest === undefined) {
            throw new Error(`Can't find Minecraft with version "${version}".`);
          }

          const response = await fetch(versionManifest.url);
          state.manifest = await response.json();
        }
      }
    );


    if (config.mode === 'client') {
      steps.push(
        {
          description: `Fetching Minecraft libraries`,
          action: async ({state}) => {
            state.natives = [];

            await build.parallelMap({
              items: state.manifest.libraries.reduce((aggr, item) => {
                if (!this.resolveMinecraftRules(item.rules)) {
                  return aggr;
                }

                if (item.downloads.artifact) {
                  aggr.push({
                    url: item.downloads.artifact.url,
                    path: path.join(location, 'libraries', item.downloads.artifact.path),
                  });
                }

                if (item.natives && item.natives[EmoSDK.getOsName()]) {
                  let obj = item.natives[EmoSDK.getOsName()];
                  let nativeArtifact = item.downloads.classifiers[obj];

                  const nativeLocation = path.join(location, 'libraries', nativeArtifact.path);
                  state.natives.push({
                    path: nativeLocation,
                    exclude: item.extract ? item.extract.exclude || [] : [],
                  });

                  aggr.push({
                    url: nativeArtifact.url,
                    path: path.join(location, 'libraries', nativeArtifact.path),
                  })
                }

                return aggr;
              }, []),
              action: async ({item}) => {
                await mkdirp(path.dirname(item.path));
                if (await exists(item.path)) {
                  return;
                }

                const res = await fetch(item.url);
                res.body.pipe(createWriteStream(item.path));
              }
            }).execute(null, state);
          }
        },
        {
          description: 'Fetching Minecraft asset index',
          action: async ({state}) => {
            const resp = await fetch(state.manifest.assetIndex.url);
            state.assetManifest = await resp.json();

            const assestIndexFolder = path.join(location, 'assets/indexes/');
            await mkdirp(assestIndexFolder);
            await fs.writeFile(path.join(assestIndexFolder, state.manifest.assetIndex.id + '.json'), JSON.stringify(state.assetManifest));
          }
        },
        {
          description: 'Fetching Minecraft assets',
          parallel: 20,
          action: async ({state}) => {
            await build.parallelMap({
              items: Object.values(state.assetManifest.objects).map(asset => {
                const assetPath = asset.hash.substr(0, 2) + '/' + asset.hash;

                return {
                  url: `${ASSESTS_HOST_URL}${assetPath}`,
                  path: path.join(location, 'assets/objects/', assetPath),
                }
              }),
              action: async ({item}) => {
                await mkdirp(path.dirname(item.path));
                if (await exists(item.path)) {
                  return;
                }

                const res = await fetch(item.url);
                res.body.pipe(createWriteStream(item.path));
              }
            }).execute();
          }
        },
        {
          description: 'Extracting natives',
          action: async ({state}) => {
            await build.parallelMap({
              items: state.natives,
              action: async ({item}) => {
                let newPromises = [];

                await createReadStream(item.path)
                  .pipe(new Parse())
                  .on('entry', async (e) => {
                    if (e.type === 'Directory') {
                      e.autodrain();
                      return;
                    }

                    if (item.exclude.find((path) => e.path.substr(0, path.length) === path)) {
                      e.autodrain();
                      return;
                    }

                    const entryLocation = path.join(location, 'natives', e.path);
                    await mkdirp(path.dirname(entryLocation))
                      .catch((e) => console.error(e));
                    await e.pipe(createWriteStream(entryLocation));
                  })
                  .promise();

                await Promise.all(newPromises);
              }
            }).execute();
          }
        }
      )
    }

    steps.push({
      description: 'Fetching Minecraft executable',
      action: async ({state}) => {
        let minecraftJar = 'minecraft.jar';

        if (config.forgeVersion) {
          minecraftJar = `minecraft_server.${version}.jar`
        }

        const minecraftPath = path.join(location, minecraftJar);
        await mkdirp(path.dirname(minecraftPath));
        const res = await fetch(state.manifest.downloads[config.mode].url);
        await res.body.pipe(createWriteStream(minecraftPath));
      }
    });

    if (config.forgeVersion) {
      steps.push(
        {
          description: 'Fetching Forge',
          action: async ({state}) => {
            let url = this.forge.getDownloadUrl({
              minecraftVersion: version,
              forgeVersion
            });

            const forgePath = path.join(location, 'forge.jar');
            await mkdirp(path.dirname(forgePath));
            const res = await fetch(url);
            await res.body.pipe(createWriteStream(forgePath));

            await new Promise((resolv, rej) => {
              res.body.on('end', () => resolv());
              res.body.on('error', (e) => rej(e));
            })
          }
        }, {
          description: 'Extracting Forge manifest',
          action: async ({state}) => {
            let forgePath = path.join(location, 'forge.jar');

            await createReadStream(path.join(location, 'forge.jar'))
              .pipe(new Parse())
              .on('entry', async (e) => {
                if (e.type === 'Directory' || e.path !== 'version.json') {
                  e.autodrain();
                  return;
                }

                let manifest = await e.buffer();
                state.forgeManifest = JSON.parse(manifest.toString('utf-8'));
              })
              .promise();
          }
        },
        {
          description: 'Fetching Forge libraries',
          action: async ({state}) => {
            state.forgeLibraries = [];
            await build.parallelMap({
              items: state.forgeManifest.libraries.reduce((aggr, item) => {
                if (!('serverreq' in item || 'clientreq' in item)) {
                  return aggr;
                }

                let [group, name, version] = item.name.split(':');

                let url = "https://libraries.minecraft.net";

                if (item.url) {
                  url = item.url;
                }

                let libPath = `/${group.replace(/\./g, '/')}/${name}/${version}/${name}-${version}.jar`;
                url += libPath;

                state.forgeLibraries.push('libraries' + libPath);

                aggr.push({
                  path: path.join(location, 'libraries', libPath),
                  url
                });

                return aggr;
              }, []),
              action: async ({item}) => {
                await mkdirp(path.dirname(item.path));
                if (await exists(item.path)) {
                  return;
                }

                const res = await fetch(item.url);
                res.body.pipe(createWriteStream(item.path));
              }
            }).execute(null, state);

            if (config.mode === 'client') {
              mkdirp(path.join(location, 'libraries/net/minecraftforge/forge'));
              await fs.rename(path.join(location, 'forge.jar'), path.join(location, 'libraries/net/minecraftforge/forge', `forge-${version}-${forgeVersion}.jar`));
              state.forgeLibraries.push(`libraries/net/minecraftforge/forge/forge-${version}-${forgeVersion}.jar`);
            }
          }
        }
      );
    }

    if (config.mode === 'client') {
      steps.push({
        description: 'Creating emo client profile',
        action: async ({state}) => {
          const translationTable = {
            'natives_directory': 'natives',
            'assets_root': 'assets',
            'assets_index_name': state.manifest.assetIndex.id,
            'version_name': state.manifest.id,
            'version_type': state.manifest.type,
            'launcher_name': 'nodejs-emo-thirdparty',
            'launcher_version': 'Ocelot',
            'game_directory': '.'
          };

          let emoClient = {
            name: config.name,
            vars: translationTable,
          };

          if (state.forgeManifest) {
            emoClient.forge = {
              minecraftArguments: state.forgeManifest.minecraftArguments,
              mainClass: state.forgeManifest.mainClass,
              libraries: state.forgeLibraries
            };
          }

          let emoClientConfig = yaml.stringify(emoClient);

          await fs.writeFile(location + '/manifest.json', JSON.stringify(state.manifest, null, 4));
          await fs.writeFile(location + '/emo.client.yml', emoClientConfig);
        }
      });
    }

    steps.push({
      description: 'Saving emo profile',
      action: async () => {
        let emoProfile = {
          name: config.name,
          minecraft: version,
          forge: forgeVersion,
          mode: config.mode,
        };

        config.minecraftVersion = version;
        config.forgeVersion = forgeVersion;

        await fs.writeFile(location + '/emo.yml', yaml.stringify(emoProfile));

        this.config.addProfile(config);
        await this.save();
      }
    });

    return build(...steps);
  }

  getMinecraftVersionsManifestTask(): Task {
    return build.one({
      description: 'Fetching Minecraft version list',
      action: async ({state}) => {
        let response = await fetch(MINECRAFT_MANIFEST_URL);
        return state.versionManifest = await response.json();
      }
    })
  }

  static getOsName() {
    let name = os.platform();

    if (name === 'darwin') {
      name = "osx";
    }

    if (name === 'win32') {
      name = "windows";
    }

    return name;
  }

  resolveMinecraftRules(rules) {
    if (!rules || !rules.length) {
      return true;
    }

    for (let rule of rules) {
      if (!this.resolveMinecraftRule(rule)) {
        return false;
      }
    }

    return true;
  }

  resolveMinecraftRule(rule) {
    let result = rule.action === 'allow';

    if (rule.os) {
      const osRule = rule.os;

      if (osRule.arch && osRule.arch !== process.arch) {
        return !result;
      }

      if (osRule.name && osRule.name !== EmoSDK.getOsName()) {
        return !result;
      }

      if (osRule.version && !new RegExp(osRule.version, 'i').test(os.release)) {
        return !result;
      }
    }

    return result;
  }

  async login(username: string, password: string) {
    const account = await this.auth.authenticate(username, password);
    this.config.addAccount(account);
    await this.save();

    return account;
  }

  listAccounts() {
    return this.config.getAccounts();
  }

  listProfiles() {
    return this.config.getProfiles();
  }

  async save() {
    await fs.writeFile(this.workspace + '/config.json', JSON.stringify(this.config.getJSON()));
  }

  static async create(workspace?: string) {
    const sdk = new EmoSDK(workspace || EmoSDK.getDefaultWorkspace());
    await sdk.init();

    return sdk;
  }

  static renderTemplateString(str, vars) {
    return str.replace(/\$\{([^\}]+)\}/g, (_, name) => {
      return vars[name] || "";
    });
  }

  static getDefaultWorkspace() {
    if (process.env.EMO_HOME) {
      return process.env.EMO_HOME;
    }

    if (process.platform === 'win32') {
      return process.env.APPDATA + '/emo';
    }

    if (process.env.HOME) {
      return process.env.HOME + '/.local/share/emo';
    }

    return '/var/lib/emo';
  }
}

module.exports = {EmoSDK};
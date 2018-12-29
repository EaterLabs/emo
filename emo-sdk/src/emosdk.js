// @flow
const mkdirp = require("./utils").mkdirp;
const {Parse} = require("unzipper");
const {promises, createWriteStream, createReadStream} = require('fs');
const fs = promises;
const {build, Task} = require("@eater/asbest");
const fetch = require("node-fetch");
const os = require("os");
const {MINECRAFT_MANIFEST_URL, ASSESTS_HOST_URL} = require("./urls");
const path = require("path");
const shellescape = require('shell-escape');

class EmoSDK {
  workspace: string;
  config;

  constructor(workspace: string) {
    this.workspace = workspace;
    this.config = {};
  }

  async init() {
    await mkdirp(this.workspace);

    try {
      const config = await fs.readFile(this.workspace + '/config.json');
      this.config = JSON.parse(config.toString('utf-8'));
    } catch (e) {
      if (e.code !== 'ENOENT') {
        throw e;
      }

      this.config = {};
      await this.save();
    }
  }

  getMinecraftInstallTask(location: string, version: string): Task {
    return build(
      this.getMinecraftVersionsManifestTask(),
      {
        description: `Fetching Minecraft version ${version} manifest`,
        action: async ({controller, state}) => {
          const versionManifest = state.versionManifest.versions.find((versionManifest) => versionManifest.id === version);

          if (versionManifest === undefined) {
            throw new Error(`Can't find Minecraft with version "${version}".`);
          }

          const response = await fetch(versionManifest.url);
          state.manifest = await response.json();
        }
      },
      {
        description: `Fetching Minecraft libraries`,
        action: async ({state}) => {
          state.natives = [];

          await build.parallelMap({
            items: state.manifest.libraries.reduce((aggr, item) => {
              if (!this.resolveMinecraftRules(item.rules)) {
                return aggr;
              }

              aggr.push({
                url: item.downloads.artifact.url,
                path: path.join(location, 'libraries', item.downloads.artifact.path),
              });

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
              console.log(item);
              await mkdirp(path.dirname(item.path));
              const res = await fetch(item.url);
              res.body.pipe(createWriteStream(item.path));
            }
          }).execute();
        }
      },
      {
        description: 'Fetching Minecraft executable',
        action: async ({state}) => {
          const minecraftPath = path.join(location, 'minecraft.jar');
          await mkdirp(path.dirname(minecraftPath));
          const res = await fetch(state.manifest.downloads.client.url);
          await res.body.pipe(createWriteStream(minecraftPath));
        }
      },
      {
        description: 'Extracting natives',
        action: async ({state}) => {
          await build.parallelMap({
            items: state.natives,
            action: async ({item}) => {
              await createReadStream(item.path)
                .pipe(new Parse())
                .on('entry', (e) => {
                  if (e.type === 'Directory') {
                    return;
                  }

                  if (item.exclude.find((path) => e.path.substr(0, path.length) === path)) {
                    return;
                  }

                  const entryLocation = path.join(location, 'natives', e.path);
                  mkdirp(path.dirname(entryLocation))
                    .then(() => {
                      e.pipe(createWriteStream(entryLocation));
                    })
                    .catch((e) => console.error(e));
                })
                .promise();
            }
          }).execute();
        }
      },
      {
        description: 'Creating emo profile',
        action: async ({state}) => {
          console.log("hoi??");

          let args = [
            'java'
          ];

          for (let arg of state.manifest.arguments.jvm) {
            if (arg.rules) {
              if (this.resolveMinecraftRules(arg.rules)) {
                args = args.concat(Array.isArray(arg.value) ? arg.value : [arg.value]);
              }

              continue;
            }

            args.push(arg);
          }

          console.log(args);

          const translationTable = {
            'natives_directory': path.join(location, 'natives'),
            'launcher_name': 'nodejs-emo-thirdparty',
            'launcher_version': 'Block of Coal',
            'classpath': state.manifest.libraries.reduce((aggr, item) => {
              if (!this.resolveMinecraftRules(item.rules)) {
                return aggr;
              }

              aggr.push(path.join(location, 'libraries', item.downloads.artifact.path));

              return aggr;
            }, []).concat([path.join(location, 'minecraft.jar')]).join(':')
          };

          const jvmArgs = args.map(arg => arg.replace(/\${([a-z0-9_]+)}/gi, (_, name) => translationTable[name]));

          jvmArgs.push('net.minecraft.client.main.Main');

          console.log(shellescape(jvmArgs));
        }
      }
    )
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
    if (!rule.os) {
      return false;
    }

    const osRule = rule.os;

    if (osRule.arch && osRule.arch !== process.arch) {
      return false;
    }

    if (osRule.name && osRule.name !== EmoSDK.getOsName()) {
      return false;
    }

    if (osRule.version && !new RegExp(osRule.version, 'i').test(os.release)) {
      return false;
    }

    return true;
  }

  async save() {
    await fs.writeFile(this.workspace + '/config.json', JSON.stringify(this.config));
  }

  static async create(workspace?: string) {
    const sdk = new EmoSDK(workspace || EmoSDK.getDefaultWorkspace());
    await sdk.init();

    return sdk;
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
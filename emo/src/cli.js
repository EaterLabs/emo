// @flow
const inquirer = require("inquirer");
const commander = require("commander");
const {EmoSDK} = require("@eater/emo-sdk");
const {spawn} = require('child_process');
const shellescape = require("shell-escape");

function wrapAsync(prom) {
  prom().catch((err) => console.error(err));
}

async function cli(program) {
  const sdk = await EmoSDK.create();

  program.command('init <name>')
    .option('-m, --minecraft [mc-version]', 'Which minecraft version should be installed, any version name or snapshot name is allowed and latest or latest-snapshot', 'latest')
    .option('-F, --forge [forge]', 'If forge should be installed, and if so what version, should be no, a forge version string, latest or recommend.')
    .option('-p, --path [path]', 'Where this minecraft version should be installed', process.cwd())
    .option('-M, --mode [mode]', 'If client or server mode should be installed', /client|server/, 'client')
    .action((name, options) => {
      wrapAsync(async () => {
        const task = sdk.getMinecraftInstallTask({
          mode: options.mode,
          path: options.path,
          minecraftVersion: options.minecraft,
          forgeVersion: (options.forge === 'no' || !options.forge) ? null : options.forge,
          name
        });
        task.on('child/execute', (t) => console.log(`[${task.ticks + 1}/${task.totalTicks}] ${t.description}`));
        task.on('child/error', (e) => console.error(e));
        await task.execute();
      });
    });

  program.command('list-profiles')
    .action(() => {
      let profiles = sdk.listProfiles();

      for (let profile of profiles) {
        console.log(`${profile.name} [${profile.path}][version: ${profile.minecraftVersion}, forge: ${profile.forgeVersion || "no"}]`)
      }
    });

  program.command('login <username>')
    .action((username) => {
      wrapAsync(async () => {
        const {auth} = await inquirer.prompt([
          {
            type: 'password',
            name: 'auth',
            message: 'Password',
            filter: async (input) => await sdk.login(username, input),
          }
        ]);

        console.log(`Logged in for ${auth.name}`);
      })
    });

  program.command('start [profile]')
    .option('-a, --account [account]', 'Which account to start Minecraft with')
    .action((profile, options) => {
      wrapAsync(async () => {
        let {program, args, pwd} = await sdk.getMinecraftStartCommand(profile || process.cwd(), options.account);
        const child = spawn(program, args, {
          stdio: 'inherit',
          cwd: pwd,
          windowsHide: true,
        });

        child.on('error', (err) => {
          console.log("Failed to start minecraft: ", err);
        });
      })
    });
}

module.exports = cli;
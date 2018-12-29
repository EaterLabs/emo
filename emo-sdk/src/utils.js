// @flow
const mkdirp_mod = require("mkdirp");

async function mkdirp(dir: string): string {
  return new Promise((res, rej) => {
    mkdirp_mod(dir, (err) => {
      if (err) {
        rej(err);
        return;
      }

      res();
    });
  });
}


module.exports = {mkdirp};
// @flow
const fetch = require("node-fetch");

type AuthenticationResult = {
  accessToken: string,
  id: string,
  name: string
};

class Auth {
  baseUrl: string;
  clientToken: string;

  async fetch(path: string, body: any) {
    const resp = await fetch(this.baseUrl + path, {
      method: 'post',
      body: JSON.stringify(body),
      headers: {'Content-Type': 'application/json'}
    });

    const respBody = await resp.json();

    if (resp.status !== 200) {
      throw new Error(`${respBody.error}: ${respBody.errorMessage}`);
    }

    return respBody;
  }

  constructor(clientToken: string, baseUrl: ?string = undefined) {
    this.baseUrl = baseUrl;
    this.clientToken = clientToken;

    if (this.baseUrl === undefined) {
      this.baseUrl = Auth.BASE_URL;
    }
  }

  async authenticate(username: string, password: string): AuthenticationResult {
    const resp = await this.fetch('/authenticate', {
      username,
      password,
      agent: Auth.AGENT,
      clientToken: this.clientToken
    });

    if (!resp.selectedProfile) {
      throw new Error("User doesn't own Minecraft");
    }

    return {
      accessToken: resp.accessToken,
      id: resp.selectedProfile.id,
      name: resp.selectedProfile.name
    };
  }


  async validate(accessToken: string): boolean {
    const resp = await fetch(this.baseUrl + '/validate', {
      method: 'post',
      body: JSON.stringify({
        clientToken: this.clientToken,
        accessToken
      }),
      headers: {'Content-Type': 'application/json'}
    });

    return resp.status === 204;
  }

  async invalidate(accessToken: string) {
    await this.fetch('/invalidate', {
      clientToken: this.clientToken,
      accessToken
    });
  }

  async refresh(accessToken: string): AuthenticationResult {
    const resp = await this.fetch('/refresh', {
      clientToken: this.clientToken,
      accessToken
    });

    if (!resp.selectedProfile) {
      throw new Error("User doesn't own Minecraft");
    }

    return {
      accessToken: resp.accessToken,
      id: resp.selectedProfile.id,
      name: resp.selectedProfile.name
    };
  }
}

Auth.BASE_URL = 'https://authserver.mojang.com';
Auth.AGENT = {
  name: "Minecraft",
  version: 1
};

module.exports = {Auth};
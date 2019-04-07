// @flow
const uuid = require("uuid/v4");

class Config {
  data: any;
  static default: any;

  constructor(data) {
    this.data = {};
    this.load(Config.default);
    this.load(data);
  }

  load(data) {
    if (!data) return;
    if (data.clientToken) {
      this.data.clientToken = data.clientToken;
    }

    if (data.profiles) {
      this.data.profiles = data.profiles;
    }

    if (data.accounts) {
      this.data.accounts = data.accounts;
    }
  }

  getClientToken(): string {
    return this.data.clientToken;
  }

  addAccount(account) {
    this.data.accounts[account.id] = account;
  }

  getAccount(accountId) {
    return this.data.accounts[accountId] || null;
  }

  selectAccount(accountId) {
    this.data.selectedAccount = accountId;
  }

  getSelectedAccount() {
    let account = this.getAccount(this.data.selectedAccount);
    if (account) {
      return account;
    }

    let accounts = this.getAccounts();

    if (accounts.length === 0) {
      return null;
    }

    this.selectAccount(accounts[0].id);
    return accounts[0];
  }

  getAccounts() {
    return Array.from(Object.values(this.data.accounts));
  }

  getProfiles() {
    return Array.from(Object.values(this.data.profiles));
  }

  addProfile(profile) {
    this.data.profiles[profile.path] = profile;
  }

  getProfile(profileId) {
    if (profileId in this.data.profiles) {
      return this.data.profiles[profileId];
    }

    return this.getProfiles().find(prof => prof.name === profileId);
  }

  getJSON() {
    return this.data;
  }
}

Config.default = {
  clientToken: uuid(),
  profiles: {},
  accounts: {},
  selectedAccount: false,
};

module.exports = {Config};
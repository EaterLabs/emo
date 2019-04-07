// @flow
const fetch = require("node-fetch");

type ForgeMinecraftVersion = {
  minecraftVersion: string;
  forgeVersion: string;
};

class Forge {
  baseUrl: string;

  constructor() {
    this.baseUrl = Forge.BASE_URL;
  }

  async getPromotions() {
    let resp = await fetch(this.baseUrl + '/net/minecraftforge/forge/promotions.json');
    return await resp.json();
  }

  async getForgeMinecraftVersion(key) {
    let promotions = await this.getPromotions();

    if (!(key in promotions.promos)) {
      return null;
    }

    let ver = promotions.promos[key];
    return {
      minecraftVersion: ver.mcversion,
      forgeVersion: ver.version
    }
  }

  async getRecommendedVersion(): ?ForgeMinecraftVersion {
    return await this.getForgeMinecraftVersion('recommended')
  }

  async getRecommendedForVersion(minecraftVersion: string): ?ForgeMinecraftVersion {
    return await this.getForgeMinecraftVersion(`${minecraftVersion}-recommended`);
  }

  async getLatestForVersion(minecraftVersion: string): ?ForgeMinecraftVersion {
    return await this.getForgeMinecraftVersion(`${minecraftVersion}-latest`);
  }

  getDownloadUrl(version: ForgeMinecraftVersion) {
    return `${this.baseUrl}/net/minecraftforge/forge/${version.minecraftVersion}-${version.forgeVersion}/forge-${version.minecraftVersion}-${version.forgeVersion}-universal.jar`;
  }
}

Forge.BASE_URL = "https://files.minecraftforge.net/maven";
module.exports = {Forge};
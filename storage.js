"use strict";

const fs = require("fs");
const { CosmosClient } = require("@azure/cosmos");

const COSMOS_SYSTEM_FIELDS = new Set(["_rid", "_self", "_etag", "_attachments", "_ts"]);
const EXTENSION_STATUS_ID = "__extension_status__";

function cleanDocument(document) {
  if (!document) return null;
  return Object.fromEntries(
    Object.entries(document).filter(([key]) => !COSMOS_SYSTEM_FIELDS.has(key))
  );
}

class FileWatchStore {
  constructor(filePath, localUserId) {
    this.filePath = filePath;
    this.localUserId = localUserId;
    this.watches = [];
    this.extensionStatuses = new Map();
  }

  async init() {
    if (fs.existsSync(this.filePath)) {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (!Array.isArray(parsed)) throw new Error("Watch data file must contain a JSON array");
      this.watches = parsed.map((watch) => ({
        ...watch,
        userId: watch.userId || this.localUserId,
      }));
      await this.persist();
    }
  }

  async persist() {
    const temporaryPath = `${this.filePath}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(this.watches, null, 2));
    fs.renameSync(temporaryPath, this.filePath);
  }

  async listAll() {
    return this.watches.map((watch) => ({ ...watch }));
  }

  async listByUser(userId) {
    return this.watches.filter((watch) => watch.userId === userId).map((watch) => ({ ...watch }));
  }

  async get(id, userId) {
    const watch = this.watches.find((item) => item.id === id && item.userId === userId);
    return watch ? { ...watch } : null;
  }

  async upsert(watch) {
    const index = this.watches.findIndex(
      (item) => item.id === watch.id && item.userId === watch.userId
    );
    if (index === -1) this.watches.push({ ...watch });
    else this.watches[index] = { ...watch };
    await this.persist();
    return { ...watch };
  }

  async delete(id, userId) {
    const before = this.watches.length;
    this.watches = this.watches.filter(
      (watch) => !(watch.id === id && watch.userId === userId)
    );
    if (this.watches.length !== before) await this.persist();
    return before - this.watches.length;
  }

  async deleteByUser(userId) {
    const before = this.watches.length;
    this.watches = this.watches.filter((watch) => watch.userId !== userId);
    if (this.watches.length !== before) await this.persist();
    return before - this.watches.length;
  }

  async getExtensionStatus(userId) {
    const status = this.extensionStatuses.get(userId);
    return status ? { ...status } : null;
  }

  async upsertExtensionStatus(status) {
    this.extensionStatuses.set(status.userId, { ...status });
    return { ...status };
  }

  async deleteExtensionStatus(userId) {
    return this.extensionStatuses.delete(userId) ? 1 : 0;
  }
}

class CosmosWatchStore {
  constructor({ endpoint, key, databaseId, containerId }) {
    this.client = new CosmosClient({ endpoint, key });
    this.container = this.client.database(databaseId).container(containerId);
  }

  async init() {
    await this.container.read();
  }

  async listAll() {
    const query = {
      query: "SELECT * FROM watches w WHERE w.id != @statusId",
      parameters: [{ name: "@statusId", value: EXTENSION_STATUS_ID }],
    };
    const { resources } = await this.container.items
      .query(query)
      .fetchAll();
    return resources.map(cleanDocument);
  }

  async listByUser(userId) {
    const query = {
      query: "SELECT * FROM watches w WHERE w.userId = @userId AND w.id != @statusId",
      parameters: [
        { name: "@userId", value: userId },
        { name: "@statusId", value: EXTENSION_STATUS_ID },
      ],
    };
    const { resources } = await this.container.items
      .query(query, { partitionKey: userId })
      .fetchAll();
    return resources.map(cleanDocument);
  }

  async get(id, userId) {
    try {
      const { resource } = await this.container.item(id, userId).read();
      return cleanDocument(resource);
    } catch (error) {
      if (error.code === 404) return null;
      throw error;
    }
  }

  async upsert(watch) {
    const { resource } = await this.container.items.upsert(cleanDocument(watch));
    return cleanDocument(resource);
  }

  async delete(id, userId) {
    try {
      await this.container.item(id, userId).delete();
      return 1;
    } catch (error) {
      if (error.code === 404) return 0;
      throw error;
    }
  }

  async deleteByUser(userId) {
    const watches = await this.listByUser(userId);
    await Promise.all(watches.map((watch) => this.container.item(watch.id, userId).delete()));
    return watches.length;
  }

  async getExtensionStatus(userId) {
    try {
      const { resource } = await this.container.item(EXTENSION_STATUS_ID, userId).read();
      return cleanDocument(resource);
    } catch (error) {
      if (error.code === 404) return null;
      throw error;
    }
  }

  async upsertExtensionStatus(status) {
    const document = {
      id: EXTENSION_STATUS_ID,
      userId: status.userId,
      documentType: "extension-status",
      ...status,
    };
    const { resource } = await this.container.items.upsert(document);
    return cleanDocument(resource);
  }

  async deleteExtensionStatus(userId) {
    try {
      await this.container.item(EXTENSION_STATUS_ID, userId).delete();
      return 1;
    } catch (error) {
      if (error.code === 404) return 0;
      throw error;
    }
  }
}

function createWatchStore({ dataFile, localUserId }) {
  const endpoint = process.env.COSMOS_ENDPOINT;
  const key = process.env.COSMOS_KEY;
  if (Boolean(endpoint) !== Boolean(key)) {
    throw new Error("COSMOS_ENDPOINT and COSMOS_KEY must be configured together");
  }
  if (!endpoint) return new FileWatchStore(dataFile, localUserId);
  return new CosmosWatchStore({
    endpoint,
    key,
    databaseId: process.env.COSMOS_DATABASE || "seatwatcher",
    containerId: process.env.COSMOS_CONTAINER || "watches",
  });
}

module.exports = { FileWatchStore, CosmosWatchStore, createWatchStore };

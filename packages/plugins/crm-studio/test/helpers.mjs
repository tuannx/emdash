function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

export function createCollection(initial = []) {
  const items = new Map();
  const stats = { statements: 0 };
  for (const item of initial) items.set(item.id, clone(item));

  return {
    async get(id) {
      stats.statements++;
      return items.has(id) ? clone(items.get(id)) : null;
    },
    async put(id, data) {
      stats.statements++;
      items.set(id, clone(data));
    },
    async delete(id) {
      stats.statements++;
      return items.delete(id);
    },
    async exists(id) {
      stats.statements++;
      return items.has(id);
    },
    async getMany(ids) {
      stats.statements++;
      const result = new Map();
      for (const id of ids) {
        if (items.has(id)) result.set(id, clone(items.get(id)));
      }
      return result;
    },
    async putMany(writes) {
      stats.statements += writes.length;
      for (const write of writes) items.set(write.id, clone(write.data));
    },
    async deleteMany(ids) {
      stats.statements += ids.length;
      let deleted = 0;
      for (const id of ids) {
        if (items.delete(id)) deleted++;
      }
      return deleted;
    },
    async query(options = {}) {
      stats.statements++;
      const where = options.where || {};
      const all = [];
      for (const [id, data] of items.entries()) {
        let matches = true;
        for (const [key, expected] of Object.entries(where)) {
          if (data[key] !== expected) {
            matches = false;
            break;
          }
        }
        if (matches) all.push({ id, data: clone(data) });
      }
      if (options.orderBy && typeof options.orderBy === "object") {
        const orderEntries = Object.entries(options.orderBy);
        all.sort((left, right) => {
          for (const [key, direction] of orderEntries) {
            const comparison = String(left.data[key] || "").localeCompare(String(right.data[key] || ""));
            if (comparison !== 0) return direction === "desc" ? -comparison : comparison;
          }
          return left.id.localeCompare(right.id);
        });
      }
      const start = options.cursor ? Number(String(options.cursor).replace("cursor:", "")) : 0;
      const limit = Math.min(options.limit || 50, 100);
      const page = all.slice(start, start + limit);
      const hasMore = start + limit < all.length;
      return {
        items: page,
        cursor: hasMore ? "cursor:" + (start + limit) : undefined,
        hasMore,
      };
    },
    async count(where = {}) {
      const result = await this.query({ where, limit: 100 });
      if (!result.hasMore) return result.items.length;
      let total = result.items.length;
      let cursor = result.cursor;
      while (cursor) {
        const page = await this.query({ where, limit: 100, cursor });
        total += page.items.length;
        cursor = page.cursor;
      }
      return total;
    },
    _items: items,
    _stats: stats,
  };
}

export function createCtx(users = []) {
  const kvValues = new Map();
  const kvStats = { statements: 0 };
  const collections = {
    profiles: createCollection(),
    segments: createCollection(),
    segmentMemberships: createCollection(),
    segmentMembershipStates: createCollection(),
    events: createCollection(),
    ingestRequests: createCollection(),
    suppressions: createCollection(),
    programs: createCollection(),
    messageTemplates: createCollection(),
    configRevisions: createCollection(),
    metricFacts: createCollection(),
    scoreRuns: createCollection(),
    emailDeliveries: createCollection(),
    trackingLinks: createCollection(),
    trackingEvents: createCollection(),
  };
  const userItems = users;
  return {
    storage: collections,
    kv: {
      async get(key) {
        kvStats.statements++;
        return kvValues.has(key) ? clone(kvValues.get(key)) : null;
      },
      async set(key, value) {
        kvStats.statements++;
        kvValues.set(key, clone(value));
      },
      async delete(key) {
        kvStats.statements++;
        return kvValues.delete(key);
      },
      async list(prefix = "") {
        kvStats.statements++;
        const output = [];
        for (const [key, value] of kvValues.entries()) {
          if (key.startsWith(prefix)) output.push({ key, value: clone(value) });
        }
        return output;
      },
      _values: kvValues,
      _stats: kvStats,
    },
    users: {
      async get(id) {
        const user = userItems.find((item) => item.id === id);
        return user ? clone(user) : null;
      },
      async getByEmail(email) {
        const user = userItems.find((item) => item.email.toLowerCase() === email.toLowerCase());
        return user ? clone(user) : null;
      },
      async list(options = {}) {
        const start = options.cursor ? Number(String(options.cursor).replace("user:", "")) : 0;
        const limit = Math.min(options.limit || 50, 100);
        const page = userItems.slice(start, start + limit).map(clone);
        return {
          items: page,
          nextCursor: start + limit < userItems.length ? "user:" + (start + limit) : undefined,
        };
      },
    },
    log: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    _users: userItems,
    _statementCount() {
      let total = kvStats.statements;
      for (const collection of Object.values(collections)) total += collection._stats.statements;
      return total;
    },
    _resetStatementCount() {
      kvStats.statements = 0;
      for (const collection of Object.values(collections)) collection._stats.statements = 0;
    },
  };
}

export function mutationInput(requestId, fields = {}) {
  return {
    schema_version: 1,
    request_id: requestId,
    source: "test_suite",
    occurred_at: new Date().toISOString(),
    ...fields,
  };
}

export function routeContext(method, input, suffix = "") {
  return {
    input,
    request: {
      url: "https://example.test/_emdash/api/plugins/crm-studio/route" + suffix,
      method,
      headers: {},
    },
  };
}

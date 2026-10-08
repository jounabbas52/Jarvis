// Action and plugin discovery — the Node port of core/action_loader.py and
// core/plugin_loader.py.
//
// A bundled action is one file in electron/mark/actions/ that exports
//
//     module.exports = {
//       TOOL: { name, description, parameters: { type: 'OBJECT', ... },
//               behavior?: 'BLOCKING' | 'NON_BLOCKING',
//               scheduling?: 'WHEN_IDLE' | 'SILENT' | 'INTERRUPT' },
//       run: async (parameters, ctx) => 'short result string',
//     };
//
// A plugin is the same idea with `PLUGIN` instead of `TOOL`, an optional
// `PLUGIN_SETTINGS = { namespace?, title?, fields: [...], action?: { label,
// run: async (values) => [ok, msg] } }`, and it can be switched off from the
// UI. Plugins are read from electron/mark/plugins/ (bundled) and from
// <userData>/mark/plugins/ (drop-in). Files starting with `_` are helpers and
// are never loaded as tools.
//
// Discovery never throws: a broken file is logged, recorded for the plugin
// manager, and skipped.

const fs = require('fs');
const path = require('path');
const config = require('./config');

const NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;
const DEFAULT_PARAMS = { type: 'OBJECT', properties: {} };
const BEHAVIORS = ['BLOCKING', 'NON_BLOCKING'];
const SCHEDULING = ['WHEN_IDLE', 'SILENT', 'INTERRUPT'];

const optUpper = (v, allowed) => {
  const s = String(v || '').trim().toUpperCase();
  return allowed.includes(s) ? s : null;
};

function validate(mod, file, key) {
  const meta = mod && mod[key];
  const stem = path.basename(file, '.js');
  if (!meta || typeof meta !== 'object') return { name: stem, file, valid: false, error: `No ${key} object.` };
  const { name, description } = meta;
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    return { name: String(name || stem), file, valid: false, error: `${key}.name missing or not a valid identifier.` };
  }
  if (typeof description !== 'string' || !description.trim()) {
    return { name, file, valid: false, error: `${key}.description missing or empty.` };
  }
  const parameters = meta.parameters || DEFAULT_PARAMS;
  if (typeof parameters !== 'object' || parameters.type !== 'OBJECT') {
    return { name, file, valid: false, error: `${key}.parameters must have type 'OBJECT'.` };
  }
  const run = typeof mod.run === 'function' ? mod.run : typeof meta.handler === 'function' ? meta.handler : null;
  if (!run) return { name, file, valid: false, error: 'Missing run(parameters, ctx) function.' };
  const settings =
    mod.PLUGIN_SETTINGS && typeof mod.PLUGIN_SETTINGS === 'object' && Array.isArray(mod.PLUGIN_SETTINGS.fields)
      ? mod.PLUGIN_SETTINGS
      : null;
  return {
    name,
    description: description.trim(),
    parameters,
    run,
    file,
    valid: true,
    error: '',
    settings,
    behavior: optUpper(meta.behavior, BEHAVIORS),
    scheduling: optUpper(meta.scheduling, SCHEDULING),
  };
}

function scan(dirs, key, reserved, logger) {
  const valid = new Map();
  const all = [];
  for (const dir of dirs) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      continue;
    }
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.js') && !f.startsWith('_'))
      .sort();
    for (const f of files) {
      const full = path.join(dir, f);
      let rec;
      try {
        const mod = require(full);
        if (key === 'TOOL' && !mod.TOOL) continue; // a helper, not an action
        rec = validate(mod, f, key);
        if (rec.valid && reserved.has(rec.name)) {
          rec = { name: rec.name, file: f, valid: false, error: `Name '${rec.name}' collides with a core tool — rejected.` };
        } else if (rec.valid && valid.has(rec.name)) {
          rec = {
            name: rec.name,
            file: f,
            valid: false,
            error: `Name '${rec.name}' already used by '${valid.get(rec.name).file}' — rejected.`,
          };
        }
      } catch (e) {
        const m = /Cannot find module '([^']+)'/.exec(String(e?.message));
        const error = m
          ? m[1].startsWith('.')
            ? `Needs the shared file '${path.basename(m[1])}', which is not next to ${f}.`
            : `Needs a package that is not installed: ${m[1]}`
          : `Failed to load: ${e?.message || e}`;
        rec = { name: path.basename(f, '.js'), file: f, valid: false, error };
        console.error(e);
      }
      all.push(rec);
      if (rec.valid) {
        valid.set(rec.name, rec);
        logger(`${key === 'TOOL' ? 'Action' : 'Plugin'} loaded: ${rec.name} (${f})`);
      } else {
        logger(`${key === 'TOOL' ? 'Action' : 'Plugin'} rejected: ${f} — ${rec.error}`);
      }
    }
  }
  return { valid, all };
}

const declOf = (rec) => {
  const d = { name: rec.name, description: rec.description, parameters: rec.parameters };
  if (rec.behavior) d.behavior = rec.behavior;
  return d;
};

class Registry {
  constructor({ actionDirs, pluginDirs, reserved, logger = console.log, notify = () => {} }) {
    const a = scan(actionDirs, 'TOOL', reserved, logger);
    this.actions = a.valid;
    const p = scan(pluginDirs, 'PLUGIN', new Set([...reserved, ...a.valid.keys()]), logger);
    this.plugins = p.valid;
    this.pluginRecords = p.all;
    this.notify = notify;
    this.logger = logger;
    const rejected = p.all.length - p.valid.size;
    if (rejected) notify(`${rejected} plugin(s) could not be loaded — see the console.`);
  }

  declarations() {
    const out = [...this.actions.values()].map(declOf);
    for (const rec of this.plugins.values()) if (config.getPluginEnabled(rec.name)) out.push(declOf(rec));
    return out;
  }

  has(name) {
    return this.actions.has(name) || this.plugins.has(name);
  }

  scheduling(name) {
    return (this.actions.get(name) || this.plugins.get(name))?.scheduling || null;
  }

  async run(name, parameters, ctx) {
    const action = this.actions.get(name);
    if (action) {
      try {
        return (await action.run(parameters || {}, ctx)) || 'Done.';
      } catch (e) {
        this.logger(`Action '${name}' crashed during run(): ${e?.stack || e}`);
        return `Tool '${name}' failed: ${e?.message || e}`;
      }
    }
    const plugin = this.plugins.get(name);
    if (!plugin) return `Unknown tool: ${name}`;
    if (!config.getPluginEnabled(name)) return `The '${name}' plugin is currently disabled.`;
    try {
      return (await plugin.run(parameters || {}, ctx)) || 'Done.';
    } catch (e) {
      this.logger(`Plugin '${name}' crashed during run(): ${e?.stack || e}`);
      this.notify(`Plugin '${name}' failed — see the console for details.`);
      return `Sir, the '${name}' plugin failed: ${e?.message || e}`;
    }
  }

  listPluginsForUi() {
    return this.pluginRecords.map((r) => ({
      name: r.name,
      description: r.description || '',
      file: r.file,
      valid: r.valid,
      error: r.error,
      enabled: r.valid ? config.getPluginEnabled(r.name) : false,
    }));
  }

  /** One section per settings namespace, for enabled plugins that declare one. */
  settingsSchemas() {
    const seen = new Set();
    const out = [];
    for (const rec of this.plugins.values()) {
      if (!rec.settings || !config.getPluginEnabled(rec.name)) continue;
      const ns = rec.settings.namespace || rec.name;
      if (seen.has(ns)) continue;
      seen.add(ns);
      out.push({
        plugin: rec.name,
        namespace: ns,
        title: rec.settings.title || rec.name,
        fields: rec.settings.fields,
        values: config.getPluginConfig(ns),
        action: rec.settings.action ? { label: rec.settings.action.label || 'Test' } : null,
      });
    }
    return out;
  }

  /** The settings form's test/connect button. Resolves to [ok, message]. */
  async runSettingsAction(namespace, values) {
    for (const rec of this.plugins.values()) {
      const ns = rec.settings && (rec.settings.namespace || rec.name);
      if (ns !== namespace) continue;
      const fn = rec.settings.action && rec.settings.action.run;
      if (typeof fn !== 'function') return [false, 'This plugin has no test action.'];
      config.savePluginConfig(namespace, values || {});
      try {
        const res = await fn(values || {});
        return Array.isArray(res) && res.length === 2 ? [Boolean(res[0]), String(res[1])] : [Boolean(res), String(res)];
      } catch (e) {
        return [false, String(e?.message || e)];
      }
    }
    return [false, 'Unknown settings section.'];
  }
}

module.exports = { Registry };

/**
 * Module containing {@link Manifest} which handles reading & writing of extension config files.
 */

import B from 'bluebird';
import glob from 'glob';
import {env, fs, util} from '@appium/support';
import _ from 'lodash';
import path from 'path';
import YAML from 'yaml';
import {CURRENT_SCHEMA_REV, DRIVER_TYPE, PLUGIN_TYPE} from '../constants';
import log from '../logger';
import {INSTALL_TYPE_NPM} from './extension-config';
import {packageDidChange} from './package-changed';
import {migrate} from './manifest-migrations';

/**
 * The name of the prop (`drivers`) used in `extensions.yaml` for drivers.
 * @type {`${typeof DRIVER_TYPE}s`}
 */
const CONFIG_DATA_DRIVER_KEY = `${DRIVER_TYPE}s`;

/**
 * The name of the prop (`plugins`) used in `extensions.yaml` for plugins.
 * @type {`${typeof PLUGIN_TYPE}s`}
 */
const CONFIG_DATA_PLUGIN_KEY = `${PLUGIN_TYPE}s`;

/**
 * @type {Readonly<ManifestData>}
 */
export const INITIAL_MANIFEST_DATA = Object.freeze({
  [CONFIG_DATA_DRIVER_KEY]: Object.freeze({}),
  [CONFIG_DATA_PLUGIN_KEY]: Object.freeze({}),
  schemaRev: CURRENT_SCHEMA_REV,
});

/**
 * Given a `package.json` return `true` if it represents an Appium Extension (either a driver or plugin).
 *
 *  _This is a type guard; not a validator._
 *
 * The `package.json` must have an `appium` property which is an object.
 * @param {any} value
 * @returns {value is ExtPackageJson<ExtensionType>}
 */
function isExtension(value) {
  return (
    _.isPlainObject(value) &&
    _.isPlainObject(value.appium) &&
    _.isString(value.name) &&
    _.isString(value.version)
  );
}

/**
 * Given a `package.json`, return `true` if it represents an Appium Driver.
 *
 * _This is a type guard; not a validator._
 *
 * To be considered a driver, a `package.json` must have an `appium.driverName` field.
 *
 * Further validation of the `appium` property happens elsewhere.
 * @param {any} value - Value to test
 * @returns {value is ExtPackageJson<DriverType>}
 */
function isDriver(value) {
  return isExtension(value) && 'driverName' in value.appium && _.isString(value.appium.driverName);
}

/**
 * Given a `package.json`, return `true` if it represents an Appium Plugin.
 *
 * _This is a type guard; not a validator._
 *
 * To be considered a plugin, a `package.json` must have an `appium.pluginName` field.
 *
 * Further validation of the `appium` property happens elsewhere.
 * @param {any} value - Value to test
 * @returns {value is ExtPackageJson<PluginType>}
 */
function isPlugin(value) {
  return isExtension(value) && 'pluginName' in value.appium && _.isString(value.appium.pluginName);
}

/**
 * Handles reading & writing of extension config files.
 *
 * Only one instance of this class exists per value of `APPIUM_HOME`.
 */
export class Manifest {
  /**
   * The entire contents of a parsed YAML extension config file.
   *
   * Contains proxies for automatic persistence on disk
   * @type {ManifestData}
   */
  #data;

  /**
   * Path to `APPIUM_HOME`.
   * @type {Readonly<string>}
   */
  #appiumHome;

  /**
   * Path to `extensions.yaml`
   * @type {string}
   * Not set until {@link Manifest.read} is called.
   */
  #manifestPath;

  /**
   * Helps avoid writing multiple times.
   *
   * If this is `undefined`, calling {@link Manifest.write} will cause it to be
   * set to a `Promise`. When the call to `write()` is complete, the `Promise`
   * will resolve and then this value will be set to `undefined`.  Concurrent calls
   * made while this value is a `Promise` will return the `Promise` itself.
   * @type {Promise<boolean>|undefined}
   */
  #writing;

  /**
   * Helps avoid reading multiple times.
   *
   * If this is `undefined`, calling {@link Manifest.read} will cause it to be
   * set to a `Promise`. When the call to `read()` is complete, the `Promise`
   * will resolve and then this value will be set to `undefined`.  Concurrent calls
   * made while this value is a `Promise` will return the `Promise` itself.
   * @type {Promise<void>|undefined}
   */
  #reading;

  /**
   * Sets internal data to a fresh clone of {@link INITIAL_MANIFEST_DATA}
   *
   * Use {@link Manifest.getInstance} instead.
   * @param {string} appiumHome
   * @private
   */
  constructor(appiumHome) {
    this.#appiumHome = appiumHome;
    this.#data = _.cloneDeep(INITIAL_MANIFEST_DATA);
  }

  /**
   * Returns a new or existing {@link Manifest} instance, based on the value of `appiumHome`.
   *
   * Maintains one instance per value of `appiumHome`.
   * @param {string} appiumHome - Path to `APPIUM_HOME`
   * @returns {Manifest}
   */
  static getInstance = _.memoize(function _getInstance(appiumHome) {
    return new Manifest(appiumHome);
  });

  /**
   * Searches `APPIUM_HOME` for installed extensions and adds them to the
   * manifest.
   *
   * Updates extensions found in the manifest via rebuilding and removes missing extensions
   * after warning the user.
   *
   * @returns {Promise<boolean>} `true` if any extensions were added, `false` otherwise.
   */
  async syncWithInstalledExtensions() {
    /**
     * "Changed" flag. If this method does anything to the internal data, this
     * will be set to `true`.  This value is returned from this method.
     */
    let didChange = false;

    /**
     * Update `didChange` if the value is truthy
     * @param {any} value
     * @returns {void}
     */
    const setChangedFlag = (value) => {
      didChange = Boolean(value) || didChange;
    };

    /**
     * Listener for the `match` event of a `glob` instance
     * @param {string} filepath - Path to a `package.json`
     * @returns {Promise<void>}
     */
    const handlePackage = async (filepath) => {
      try {
        const pkg = JSON.parse(await fs.readFile(filepath, 'utf8'));
        if (isExtension(pkg)) {
          /** @type {ExtensionType} */
          let extType;
          /** @type {string} */
          let name;
          /** @type {boolean} */
          let isNew;

          if (isDriver(pkg)) {
            extType = DRIVER_TYPE;
            name = pkg.appium.driverName;
            isNew = !this.hasDriver(name);
          } else if (isPlugin(pkg)) {
            extType = PLUGIN_TYPE;
            name = pkg.appium.pluginName;
            isNew = !this.hasPlugin(name);
          } else {
            log.warn(
              `Discovered possible extension in package "${pkg.name}" but it is invalid. Try reinstalling it or updating to a new version.`
            );
            return;
          }

          if (isNew) {
            log.info(`Discovered installed ${extType} "${name}"`);
          }

          try {
            setChangedFlag(this.addExtensionFromPackage(pkg, filepath));
          } finally {
            // remove the extension from the missing list, if it's there
            if (isDriver(pkg)) {
              missingDrivers.delete(pkg.name);
            } else {
              missingPlugins.delete(pkg.name);
            }
          }
        }
      } catch (err) {
        // only eat ENOENT errors in which `package.json` is missing.
        if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') {
          log.warn(err);
        }
      }
    };

    /**
     * Lookup of drivers found in the manifest, by package name.
     *
     * Used to remove missing drivers from the manifest.
     * @type {Map<string, {installPath?: string, name: string}>}
     */
    const missingDrivers = new Map(
      Object.entries(this.#data.drivers).map(([name, driver]) => [
        driver.pkgName,
        {installPath: driver.installPath, name},
      ])
    );

    /**
     * Lookup of plugins found in the manifest, by package name
     *
     * Used to remove missing drivers from the manifest.
     * @type {Map<string, {installPath?: string, name: string}>}
     */
    const missingPlugins = new Map(
      Object.entries(this.#data.plugins).map(([name, plugin]) => [
        plugin.pkgName,
        {installPath: plugin.installPath, name},
      ])
    );

    /**
     * A list of `Promise`s which read `package.json` files looking for Appium extensions.
     * @type {Promise<void>[]}
     */
    const queue = [
      // look at `package.json` in `APPIUM_HOME` only
      handlePackage(path.join(this.#appiumHome, 'package.json')),
    ];

    // add dependencies to the queue
    await new B((resolve, reject) => {
      glob(
        'node_modules/{*,@*/*}/package.json',
        {cwd: this.#appiumHome, silent: true, absolute: true},
        // eslint-disable-next-line promise/prefer-await-to-callbacks
        (err) => {
          if (err) {
            reject(err);
          }
          resolve();
        }
      )
        .on('error', reject)
        .on('match', (filepath) => {
          queue.push(handlePackage(filepath));
        });
    });

    // wait for the extensions found by glob to be processed
    await B.all(queue);

    // there might be stuff left over that isn't where we'd expect it to be.
    // use the `installPath` field, if present, to find it.
    for (const {installPath} of [...missingDrivers.values(), ...missingPlugins.values()]) {
      if (installPath) {
        queue.push(handlePackage(installPath));
      }
    }

    // wait for extensions-by-`installPath` to be processed
    await B.all(queue);

    setChangedFlag(this.#removeMissingExtensions(DRIVER_TYPE, missingDrivers));
    setChangedFlag(this.#removeMissingExtensions(PLUGIN_TYPE, missingPlugins));

    return didChange;
  }

  /**
   * Given a mapping of missing-on-disk extensions, remove them from the manifest
   * @param {ExtensionType} extType
   * @param {Map<string, {installPath?: string, name: string}>} missingExtMap
   * @returns {boolean} If any extensions were removed
   */
  #removeMissingExtensions(extType, missingExtMap) {
    if (missingExtMap.size) {
      log.warn(
        `Removing ${util.pluralize('reference', missingExtMap.size)} to ${util.pluralize(
          extType,
          missingExtMap.size,
          true
        )} in the manifest that could not be found on disk: ${_.map(
          [...missingExtMap.values()],
          'name'
        ).join(', ')}; `
      );
      for (const {name} of missingExtMap.values()) {
        delete this.#data[`${extType}s`][name];
      }
      return true;
    }
    return false;
  }

  /**
   * Returns `true` if driver with name `name` is registered.
   * @param {string} name - Driver name
   * @returns {boolean}
   */
  hasDriver(name) {
    return Boolean(this.#data.drivers[name]);
  }

  /**
   * Returns `true` if plugin with name `name` is registered.
   * @param {string} name - Plugin name
   * @returns {boolean}
   */
  hasPlugin(name) {
    return Boolean(this.#data.plugins[name]);
  }

  /**
   * Given a path to a `package.json`, add it as either a driver or plugin to the manifest.
   *
   * @template {ExtensionType} ExtType
   * @param {ExtPackageJson<ExtType>} pkgJson
   * @param {string} pkgPath
   * @returns {boolean} - `true` if this method did anything.
   */
  addExtensionFromPackage(pkgJson, pkgPath) {
    const extensionPath = path.dirname(pkgPath);

    /**
     * @type {InternalMetadata}
     */
    const internal = {
      pkgName: pkgJson.name,
      version: pkgJson.version,
      appiumVersion: pkgJson.peerDependencies?.appium,
      installType: INSTALL_TYPE_NPM,
      installSpec: `${pkgJson.name}@${pkgJson.version}`,
      installPath: extensionPath,
    };

    if (isDriver(pkgJson)) {
      const value = {
        ..._.omit(pkgJson.appium, 'driverName'),
        ...internal,
      };
      if (!_.isEqual(value, this.#data.drivers[pkgJson.appium.driverName])) {
        this.setExtension(DRIVER_TYPE, pkgJson.appium.driverName, value);
        return true;
      }
      return false;
    } else if (isPlugin(pkgJson)) {
      const value = {
        ..._.omit(pkgJson.appium, 'pluginName'),
        ...internal,
      };
      if (!_.isEqual(value, this.#data.plugins[pkgJson.appium.pluginName])) {
        this.setExtension(PLUGIN_TYPE, pkgJson.appium.pluginName, value);
        return true;
      }
      return false;
    } else {
      throw new TypeError(
        `The extension in ${extensionPath} is neither a valid ${DRIVER_TYPE} nor a valid ${PLUGIN_TYPE}.`
      );
    }
  }

  /**
   * Adds an extension to the manifest as was installed by the `appium` CLI.  The
   * `extData`, `extType`, and `extName` have already been determined.
   *
   * See {@link Manifest.addExtensionFromPackage} for adding an extension from an on-disk package.
   * @template {ExtensionType} ExtType
   * @param {ExtType} extType - `driver` or `plugin`
   * @param {string} extName - Name of extension
   * @param {ExtManifest<ExtType>} extData - Extension metadata
   * @returns {ExtManifest<ExtType>} A clone of `extData`, potentially with a mutated `appiumVersion` field
   */
  setExtension(extType, extName, extData) {
    const data = _.cloneDeep(extData);
    this.#data[`${extType}s`][extName] = data;
    return data;
  }

  /**
   * Sets the schema revision
   * @param {keyof import('./manifest-migrations').ManifestDataVersions} rev
   */
  setSchemaRev(rev) {
    this.#data.schemaRev = rev;
  }

  /**
   * Remove an extension from the manifest.
   * @param {ExtensionType} extType
   * @param {string} extName
   */
  deleteExtension(extType, extName) {
    delete this.#data[`${extType}s`][extName];
  }

  /**
   * Returns the `APPIUM_HOME` path
   */
  get appiumHome() {
    return this.#appiumHome;
  }

  /**
   * Returns the path to the manifest file (`extensions.yaml`)
   */
  get manifestPath() {
    return this.#manifestPath;
  }

  /**
   * Returns the schema rev of this manifest
   */
  get schemaRev() {
    return this.#data.schemaRev;
  }

  /**
   * Returns extension data for a particular type.
   *
   * @template {ExtensionType} ExtType
   * @param {ExtType} extType
   * @returns {Readonly<ExtRecord<ExtType>>}
   */
  getExtensionData(extType) {
    return this.#data[/** @type {string} */ (`${extType}s`)];
  }

  /**
   * Reads manifest from disk and _overwrites_ the internal data.
   *
   * If the manifest does not exist on disk, an
   * {@link INITIAL_MANIFEST_DATA "empty"} manifest file will be created, as
   * well as its directory if needed.
   *
   * This will also, if necessary:
   * 1. perform a migration of the manifest data
   * 2. sync the manifest with extensions on-disk (kind of like "auto
   *    discovery")
   * 3. write the manifest to disk.
   *
   * Only one read operation can happen at a time.
   *
   * @returns {Promise<ManifestData>} The data
   */
  async read() {
    if (this.#reading) {
      await this.#reading;
      return this.#data;
    }

    this.#reading = (async () => {
      /** @type {ManifestData} */
      let data;
      /**
       * This will be `true` if, after reading, we need to update the manifest data
       * and write it again to disk.
       */
      let shouldWrite = false;
      await this.#setManifestPath();
      try {
        const yaml = await fs.readFile(this.#manifestPath, 'utf8');
        data = YAML.parse(yaml);
        log.debug(
          `Parsed manifest file at ${this.#manifestPath}: ${JSON.stringify(data, null, 2)}`
        );
      } catch (err) {
        if (err.code === 'ENOENT') {
          log.debug(`No manifest file found at ${this.#manifestPath}; creating`);
          data = _.cloneDeep(INITIAL_MANIFEST_DATA);
          shouldWrite = true;
        } else {
          if (this.#manifestPath) {
            throw new Error(
              `Appium had trouble loading the extension installation ` +
                `cache file (${this.#manifestPath}). It may be invalid YAML. Specific error: ${
                  err.message
                }`
            );
          } else {
            throw new Error(
              `Appium encountered an unknown problem. Specific error: ${err.message}`
            );
          }
        }
      }

      this.#data = data;

      /**
       * the only way `shouldWrite` is `true` is if we have a new file.  a new
       * file will get the latest schema revision, so we can skip the migration.
       */
      if (!shouldWrite && (data.schemaRev ?? 0) < CURRENT_SCHEMA_REV) {
        log.debug(
          `Updating manifest schema from rev ${data.schemaRev ?? '(none)'} to ${CURRENT_SCHEMA_REV}`
        );
        shouldWrite = await migrate(this);
      }

      /**
       * we still may want to sync with installed extensions even if we have a
       * new file. right now this is limited to the following cases:
       * 1. we have a brand new manifest file
       * 2. we have performed a migration on a manifest file
       * 3. `appium` is a dependency within `package.json`, and `package.json`
       *    has changed since last time we checked.
       */
      if (
        shouldWrite ||
        ((await env.hasAppiumDependency(this.appiumHome)) &&
          (await packageDidChange(this.appiumHome)))
      ) {
        log.debug('Discovering newly installed extensions...');
        shouldWrite = (await this.syncWithInstalledExtensions()) || shouldWrite;
      }

      if (shouldWrite) {
        await this.write();
      }
    })();

    try {
      await this.#reading;
      return this.#data;
    } finally {
      this.#reading = undefined;
    }
  }

  /**
   * Ensures the internal manifest path is set.
   *
   * Creates the directory if necessary.
   * @returns {Promise<string>}
   */
  async #setManifestPath() {
    if (!this.#manifestPath) {
      this.#manifestPath = await env.resolveManifestPath(this.#appiumHome);

      /* istanbul ignore if */
      if (path.relative(this.#appiumHome, this.#manifestPath).startsWith('.')) {
        throw new Error(
          `Mismatch between location of APPIUM_HOME and manifest file. APPIUM_HOME: ${
            this.appiumHome
          }, manifest file: ${this.#manifestPath}`
        );
      }
    }

    return this.#manifestPath;
  }

  /**
   * Writes the data if it need s writing.
   *
   * If the `schemaRev` prop needs updating, the file will be written.
   *
   * @todo If this becomes too much of a bottleneck, throttle it.
   * @returns {Promise<boolean>} Whether the data was written
   */
  async write() {
    if (this.#writing) {
      return this.#writing;
    }
    this.#writing = (async () => {
      await this.#setManifestPath();
      try {
        await fs.mkdirp(path.dirname(this.#manifestPath));
      } catch (err) {
        throw new Error(
          `Appium could not create the directory for the manifest file: ${path.dirname(
            this.#manifestPath
          )}. Original error: ${err.message}`
        );
      }
      try {
        await fs.writeFile(this.#manifestPath, YAML.stringify(this.#data), 'utf8');
        return true;
      } catch (err) {
        throw new Error(
          `Appium could not write to manifest at ${this.#manifestPath} using APPIUM_HOME ${
            this.#appiumHome
          }. Please ensure it is writable. Original error: ${err.message}`
        );
      }
    })();
    try {
      return await this.#writing;
    } finally {
      this.#writing = undefined;
    }
  }
}

/**
 * Type of the string referring to a driver (typically as a key or type string)
 * @typedef {import('@appium/types').DriverType} DriverType
 */

/**
 * Type of the string referring to a plugin (typically as a key or type string)
 * @typedef {import('@appium/types').PluginType} PluginType
 */

/**
 * @typedef SyncWithInstalledExtensionsOpts
 * @property {number} [depthLimit] - Maximum depth to recurse into subdirectories
 */

/**
 * @typedef {import('appium/types').ManifestData} ManifestData
 * @typedef {import('appium/types').InternalMetadata} InternalMetadata
 */

/**
 * @template {ExtensionType} ExtType
 * @typedef {import('appium/types').ExtPackageJson<ExtType>} ExtPackageJson
 */

/**
 * @template {ExtensionType} ExtType
 * @typedef {import('appium/types').ExtManifest<ExtType>} ExtManifest
 */

/**
 * @template {ExtensionType} ExtType
 * @typedef {import('appium/types').ExtRecord<ExtType>} ExtRecord
 */

/**
 * Either `driver` or `plugin` rn
 * @typedef {import('@appium/types').ExtensionType} ExtensionType
 */

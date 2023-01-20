#!/usr/bin/env node

/* eslint-disable no-console, promise/prefer-await-to-then */

/**
 * This script is intended to be run as a `postinstall` lifecycle script,
 * and will automatically install extensions if requested by the user.
 *
 * If the current working directory is within a project which has `appium`
 * as a dependency, this script does nothing; extensions must be managed
 * via `npm` or another package manager.
 *
 * If `CI=1` is in the environment, this script will exit with a non-zero
 * code upon failure (which will typically break a build).  Otherwise, it
 * will always exit with code 0, even if errors occur.
 *
 * @module
 * @example
 * `npm install -g appium --drivers=uiautomator2,xcuitest --plugins=images`
 */

const B = require('bluebird');

B.config({
  cancellation: true,
});

/** @type {import('../lib/cli/extension').runExtensionCommand} */
let runExtensionCommand;
/** @type {import('../lib/constants').DRIVER_TYPE} */
let DRIVER_TYPE;
/** @type {import('../lib/constants').PLUGIN_TYPE} */
let PLUGIN_TYPE;
/** @type {import('../lib/extension').loadExtensions} */
let loadExtensions;

const _ = require('lodash');
const wrap = _.partial(
  require('wrap-ansi'),
  _,
  process.stderr.columns ?? process.stdout.columns ?? 80
);
const ora = require('ora');

let env, util, logger;

function log(message) {
  console.error(wrap(`[Appium] ${message}`));
}

/**
 * Setup / check environment if we should do anything here
 * @returns {Promise<boolean>} `true` if Appium is built and ready to go
 */
async function init() {
  try {
    ({env, util, logger} = require('@appium/support'));
    ({runExtensionCommand} = require('../build/lib/cli/extension'));
    ({DRIVER_TYPE, PLUGIN_TYPE} = require('../build/lib/constants'));
    ({loadExtensions} = require('../build/lib/extension'));
    logger.getLogger('Appium').level = 'error';

    // if we're doing `npm install -g appium` then we will assume we don't have a local appium.
    if (!process.env.npm_config_global && (await env.hasAppiumDependency())) {
      log(`Found local Appium installation; skipping automatic installation of extensions.`);
      return false;
    }
    return true;
  } catch {
    log('Dev environment likely; skipping automatic installation of extensions');
    return false;
  }
}

async function main() {
  if (!(await init())) {
    return;
  }

  const driverEnv = process.env.npm_config_drivers;
  const pluginEnv = process.env.npm_config_plugins;

  const spinner = ora({
    text: 'Looking for extensions to automatically install...',
    prefixText: '[Appium]',
  }).start();

  if (!driverEnv && !pluginEnv) {
    spinner.succeed(
      wrap(`No drivers or plugins to automatically install. 
      If desired, provide arguments with comma-separated values "--drivers=<known_driver>[,known_driver...]" and/or "--plugins=<known_plugin>[,known_plugin...]" to the "npm install appium" command. The specified extensions will be installed automatically with Appium.  Note: to see the list of known extensions, run "appium <driver|plugin> list".`)
    );
    return;
  }

  const specs = [
    [DRIVER_TYPE, driverEnv],
    [PLUGIN_TYPE, pluginEnv],
  ];

  spinner.start('Resolving Appium home directory...');
  const appiumHome = await env.resolveAppiumHome();
  spinner.succeed(`Found Appium home: ${appiumHome}`);

  spinner.start('Loading extension data...');
  const {driverConfig, pluginConfig} = await loadExtensions(appiumHome);
  spinner.succeed('Loaded extension data.');

  const installedStats = {[DRIVER_TYPE]: 0, [PLUGIN_TYPE]: 0};
  for (const [type, extEnv] of specs) {
    if (extEnv) {
      for await (let ext of extEnv.split(',')) {
        ext = ext.trim();
        try {
          await checkAndInstallExtension({
            runExtensionCommand,
            appiumHome,
            type,
            ext,
            driverConfig,
            pluginConfig,
            spinner,
          });
          installedStats[type]++;
        } catch (e) {
          spinner.fail(`Could not install ${type} "${ext}": ${e.message}`);
          if (process.env.CI) {
            process.exitCode = 1;
          }
          return;
        }
      }
    }
  }
  spinner.succeed(
    `Done. ${installedStats[DRIVER_TYPE]} ${util.pluralize(
      'driver',
      installedStats[DRIVER_TYPE]
    )} and ${installedStats[PLUGIN_TYPE]} ${util.pluralize(
      'plugin',
      installedStats[PLUGIN_TYPE]
    )} are installed.`
  );
}

async function checkAndInstallExtension({
  runExtensionCommand,
  appiumHome,
  type,
  ext,
  driverConfig,
  pluginConfig,
  spinner,
}) {
  const extList = await runExtensionCommand(
    {
      appiumHome,
      [`${type}Command`]: 'list',
      showInstalled: true,
      suppressOutput: true,
    },
    type === DRIVER_TYPE ? driverConfig : pluginConfig
  );
  if (extList[ext]) {
    spinner.info(`The ${type} "${ext}" is already installed.`);
    return;
  }
  spinner.start(`Installing ${type} "${ext}"...`);
  await runExtensionCommand(
    {
      appiumHome,
      [`${type}Command`]: 'install',
      suppressOutput: true,
      [type]: ext,
    },
    type === DRIVER_TYPE ? driverConfig : pluginConfig
  );
  spinner.succeed(`Installed ${type} "${ext}".`);
}

if (require.main === module) {
  main().catch((e) => {
    log(e);
    process.exitCode = 1;
  });
}

module.exports = main;

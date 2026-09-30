/**
 * This file can be edited to adjust the ESBuild build process.
 * To reset, delete this file and rerun theia build again.
 */
import { browserOptions, watch } from './gen-esbuild.browser.mjs';
import { nodeOptions } from './gen-esbuild.node.mjs';

import esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Remove drivelist from nativeBindings so nativeDependenciesPlugin doesn't try to copy it
const patchedNodeOptions = { ...nodeOptions, plugins: [...nodeOptions.plugins] };
if (patchedNodeOptions.plugins) {
    const ndpIndex = patchedNodeOptions.plugins.findIndex(p => p.name === 'nativeDependencies');
    if (ndpIndex >= 0) {
        // We can't modify the plugin directly, but we can remove drivelist from the
        // nativeBindings object that was imported - since gen-esbuild.node.mjs exports it,
        // we patch the exported object
    }
}

// Patch the exported nativeBindings object to remove drivelist
// This prevents nativeDependenciesPlugin from trying to resolve/copy the native binary
import { nativeBindings } from './gen-esbuild.node.mjs';
delete nativeBindings.drivelist;

const browserContext = await esbuild.context({
    ...browserOptions,
});
const nodeContext = await esbuild.context({
    ...nodeOptions,
});

// Post-build patch: replace the broken drivelist native require with a JS mock
const patchMainJs = () => {
    try {
        const mainPath = join(__dirname, 'lib', 'backend', 'main.js');
        let content = readFileSync(mainPath, 'utf-8');
        // Replace the require for the native drivelist binary with a JS mock
        const oldPattern = /require\(['"]drivelist\/build\/Release\/drivelist\.node['"]\)/g;
        const replacement = '(function(){return {list:function(cb){cb(null,[]);}};})()';
        if (oldPattern.test(content)) {
            content = content.replace(oldPattern, replacement);
            writeFileSync(mainPath, content, 'utf-8');
            console.log('[esbuild] Patched main.js: replaced drivelist native require with JS mock');
        }
    } catch (e) {
        console.warn('[esbuild] Failed to patch main.js:', e.message);
    }
};

if (watch) {
    await Promise.all([
        browserContext.watch(),
        nodeContext.watch(),
    ]);
} else {
    try {
        await browserContext.rebuild();
        await browserContext.dispose();
        await nodeContext.rebuild();
        await nodeContext.dispose();
        patchMainJs();
    } catch {
        process.exit(1);
    }
}

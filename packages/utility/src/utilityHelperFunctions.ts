import core = require('@actions/core');
import path = require('path');
import * as fs from "fs";
var shell = require('shelljs');
var minimatch = require('minimatch');

export function cp(source: string, dest: string, options?: string, continueOnError?: boolean): void {
    if (options) {
        shell.cp(options, source, dest);
    }
    else {
        shell.cp(source, dest);
    }

    _checkShell('cp', continueOnError);
}

export function _checkShell(cmd: string, continueOnError?: boolean) {
    var se = shell.error();

    if (se) {
        core.debug(cmd + ' failed');
        var errMsg = 'Failed ' + cmd + ': ' + se;
        core.debug(errMsg);

        if (!continueOnError) {
            throw new Error(errMsg);
        }
    }
}

export function mkdirP(p: string): void {
    if (!p) {
        throw new Error('p not supplied');
    }

    // build a stack of directories to create
    let stack: string[] = [];
    let testDir: string = p;
    while (true) {
        // validate the loop is not out of control
        if (stack.length >= (process.env['TASKLIB_TEST_MKDIRP_FAILSAFE'] || 1000)) {
            // let the framework throw
            core.debug('loop is out of control');
            fs.mkdirSync(p);
            return;
        }

        core.debug(`testing directory '${testDir}'`);
        let stats: fs.Stats;
        try {
            stats = fs.statSync(testDir);
        } catch (err) {
            if (err.code == 'ENOENT') {
                // validate the directory is not the drive root
                let parentDir = path.dirname(testDir);
                if (testDir == parentDir) {
                    throw new Error('Unable to create directory ' + p + '. Root directory does not exist: ' + testDir);
                }

                // push the dir and test the parent
                stack.push(testDir);
                testDir = parentDir;
                continue;
            }
            else if (err.code == 'UNKNOWN') {
                throw new Error('Unable to create directory ' + p + '. Unable to verify the directory exists: ' + testDir + '. If directory is a file share, please verify the share name is correct, the share is online, and the current process has permission to access the share.');
            }
            else {
                throw err;
            }
        }

        if (!stats.isDirectory()) {
            throw new Error('Unable to create directory ' + p + '. Conflicting file exists: ' + testDir);
        }

        // testDir exists
        break;
    }

    // create each directory
    while (stack.length) {
        let dir = stack.pop()!; // non-null because `stack.length` was truthy
        core.debug(`mkdir '${dir}'`);
        try {
            fs.mkdirSync(dir);
        } catch (err) {
            throw new Error('Unable to create directory ' +  p + ' . ' + err.message);
        }
    }
}

export function find(findPath: string): string[] {
    if (!findPath) {
        core.debug('no path specified');
        return [];
    }

    // normalize the path, otherwise the first result is inconsistently formatted from the rest of the results
    // because path.join() performs normalization.
    findPath = path.normalize(findPath);

    // debug trace the parameters
    core.debug(`findPath: '${findPath}'`);

    // return empty if not exists
    try {
        fs.lstatSync(findPath);
    }
    catch (err) {
        if (err.code == 'ENOENT') {
            core.debug('0 results')
            return [];
        }

        throw err;
    }

    try {
        let result: string[] = [];

        // push the first item
        let stack: _FindItem[] = [new _FindItem(findPath, 1)];
        let traversalChain: string[] = []; // used to detect cycles

        while (stack.length) {
            // pop the next item and push to the result array
            let item = stack.pop()!; // non-null because `stack.length` was truthy
            result.push(item.path);

            // stat the item.  the stat info is used further below to determine whether to traverse deeper
            //
            // stat returns info about the target of a symlink (or symlink chain),
            // lstat returns info about a symlink itself
            let stats: fs.Stats;
            // use lstat (not following symlinks)
            stats = fs.lstatSync(item.path);

            // note, isDirectory() returns false for the lstat of a symlink
            if (stats.isDirectory()) {
                core.debug(`  ${item.path} (directory)`);

                // push the child items in reverse onto the stack
                let childLevel: number = item.level + 1;
                let childItems: _FindItem[] =
                    fs.readdirSync(item.path)
                        .map((childName: string) => new _FindItem(path.join(item.path, childName), childLevel));
                for (var i = childItems.length - 1; i >= 0; i--) {
                    stack.push(childItems[i]);
                }
            }
            else {
                core.debug(`  ${item.path} (file)`);
            }
        }

        core.debug(`${result.length} results`);
        return result;
    }
    catch (err) {
        throw new Error('Failed find: ' + err.message);
    }
}

class _FindItem {
    public path: string;
    public level: number;

    public constructor(path: string, level: number) {
        this.path = path;
        this.level = level;
    }
}

interface MatchOptions {
    debug?: boolean;
    nobrace?: boolean;
    noglobstar?: boolean;
    dot?: boolean;
    noext?: boolean;
    nocase?: boolean;
    nonull?: boolean;
    matchBase?: boolean;
    nocomment?: boolean;
    nonegate?: boolean;
    flipNegate?: boolean;
}

function _getDefaultMatchOptions(): MatchOptions {
    return <MatchOptions>{
        debug: false,
        nobrace: true,
        noglobstar: false,
        dot: true,
        noext: false,
        nocase: process.platform == 'win32',
        nonull: false,
        matchBase: false,
        nocomment: false,
        nonegate: false,
        flipNegate: false
    };
}

function _debugMatchOptions(options: MatchOptions): void {
    core.debug(`matchOptions.debug: '${options.debug}'`);
    core.debug(`matchOptions.nobrace: '${options.nobrace}'`);
    core.debug(`matchOptions.noglobstar: '${options.noglobstar}'`);
    core.debug(`matchOptions.dot: '${options.dot}'`);
    core.debug(`matchOptions.noext: '${options.noext}'`);
    core.debug(`matchOptions.nocase: '${options.nocase}'`);
    core.debug(`matchOptions.nonull: '${options.nonull}'`);
    core.debug(`matchOptions.matchBase: '${options.matchBase}'`);
    core.debug(`matchOptions.nocomment: '${options.nocomment}'`);
    core.debug(`matchOptions.nonegate: '${options.nonegate}'`);
    core.debug(`matchOptions.flipNegate: '${options.flipNegate}'`);
}

export function match(list: string[], patterns: string[] | string, patternRoot?: string, options?: MatchOptions): string[] {
    // trace parameters
    core.debug(`patternRoot: '${patternRoot}'`);
    options = options || _getDefaultMatchOptions(); // default match options
    _debugMatchOptions(options);

    // convert pattern to an array
    if (typeof patterns == 'string') {
        patterns = [patterns as string];
    }

    // hashtable to keep track of matches
    let map: { [item: string]: boolean } = {};

    let originalOptions = options;
    for (let pattern of patterns) {
        core.debug(`pattern: '${pattern}'`);

        // trim and skip empty
        pattern = (pattern || '').trim();
        if (!pattern) {
            core.debug('skipping empty pattern');
            continue;
        }

        // clone match options
        let options = _cloneMatchOptions(originalOptions);

        // skip comments
        if (!options.nocomment && _startsWith(pattern, '#')) {
            core.debug('skipping comment');
            continue;
        }

        // set nocomment - brace expansion could result in a leading '#'
        options.nocomment = true;

        // determine whether pattern is include or exclude
        let negateCount = 0;
        if (!options.nonegate) {
            while (pattern.charAt(negateCount) == '!') {
                negateCount++;
            }

            pattern = pattern.substring(negateCount); // trim leading '!'
            if (negateCount) {
                core.debug(`trimmed leading '!'. pattern: '${pattern}'`);
            }
        }

        let isIncludePattern = negateCount == 0 ||
            (negateCount % 2 == 0 && !options.flipNegate) ||
            (negateCount % 2 == 1 && options.flipNegate);

        // set nonegate - brace expansion could result in a leading '!'
        options.nonegate = true;
        options.flipNegate = false;

        // expand braces - required to accurately root patterns
        let expanded: string[];
        let preExpanded: string = pattern;
        if (options.nobrace) {
            expanded = [pattern];
        }
        else {
            // convert slashes on Windows before calling braceExpand(). unfortunately this means braces cannot
            // be escaped on Windows, this limitation is consistent with current limitations of minimatch (3.0.3).
            core.debug('expanding braces');
            let convertedPattern = process.platform == 'win32' ? pattern.replace(/\\/g, '/') : pattern;
            expanded = (minimatch as any).braceExpand(convertedPattern);
        }

        // set nobrace
        options.nobrace = true;

        for (let pattern of expanded) {
            if (expanded.length != 1 || pattern != preExpanded) {
                core.debug(`pattern: '${pattern}'`);
            }

            // trim and skip empty
            pattern = (pattern || '').trim();
            if (!pattern) {
                core.debug('skipping empty pattern');
                continue;
            }

            // root the pattern when all of the following conditions are true:
            if (patternRoot &&          // patternRoot supplied
                !_isRooted(pattern) &&  // AND pattern not rooted
                // AND matchBase:false or not basename only
                (!options.matchBase || (process.platform == 'win32' ? pattern.replace(/\\/g, '/') : pattern).indexOf('/') >= 0)) {

                pattern = _ensureRooted(patternRoot, pattern);
                core.debug(`rooted pattern: '${pattern}'`);
            }

            if (isIncludePattern) {
                // apply the pattern
                core.debug('applying include pattern against original list');
                let matchResults: string[] = minimatch.match(list, pattern, options);
                core.debug(matchResults.length + ' matches');

                // union the results
                for (let matchResult of matchResults) {
                    map[matchResult] = true;
                }
            }
            else {
                // apply the pattern
                core.debug('applying exclude pattern against original list');
                let matchResults: string[] = minimatch.match(list, pattern, options);
                core.debug(matchResults.length + ' matches');

                // substract the results
                for (let matchResult of matchResults) {
                    delete map[matchResult];
                }
            }
        }
    }

    // return a filtered version of the original list (preserves order and prevents duplication)
    let result: string[] = list.filter((item: string) => map.hasOwnProperty(item));
    core.debug(result.length + ' final results');
    return result;
}

function _cloneMatchOptions(matchOptions: MatchOptions): MatchOptions {
    return <MatchOptions>{
        debug: matchOptions.debug,
        nobrace: matchOptions.nobrace,
        noglobstar: matchOptions.noglobstar,
        dot: matchOptions.dot,
        noext: matchOptions.noext,
        nocase: matchOptions.nocase,
        nonull: matchOptions.nonull,
        matchBase: matchOptions.matchBase,
        nocomment: matchOptions.nocomment,
        nonegate: matchOptions.nonegate,
        flipNegate: matchOptions.flipNegate
    };
}


function _startsWith(str: string, start: string): boolean {
    return str.slice(0, start.length) == start;
}

function _isRooted(p: string): boolean {
    p = _normalizeSeparators(p);
    if (!p) {
        throw new Error('isRooted() parameter "p" cannot be empty');
    }

    if (process.platform == 'win32') {
        return _startsWith(p, '\\') || // e.g. \ or \hello or \\hello
            /^[A-Z]:/i.test(p);      // e.g. C: or C:\hello
    }

    return _startsWith(p, '/'); // e.g. /hello
}

function _ensureRooted(root: string, p: string) {
    if (!root) {
        throw new Error('ensureRooted() parameter "root" cannot be empty');
    }

    if (!p) {
        throw new Error('ensureRooted() parameter "p" cannot be empty');
    }

    if (_isRooted(p)) {
        return p;
    }

    if (process.platform == 'win32' && root.match(/^[A-Z]:$/i)) { // e.g. C:
        return root + p;
    }

    // ensure root ends with a separator
    if (_endsWith(root, '/') || (process.platform == 'win32' && _endsWith(root, '\\'))) {
        // root already ends with a separator
    }
    else {
        root += path.sep; // append separator
    }

    return root + p;
}

function _normalizeSeparators(p: string): string {
    p = p || '';
    if (process.platform == 'win32') {
        // convert slashes on Windows
        p = p.replace(/\//g, '\\');

        // remove redundant slashes
        let isUnc = /^\\\\+[^\\]/.test(p); // e.g. \\hello
        return (isUnc ? '\\' : '') + p.replace(/\\\\+/g, '\\'); // preserve leading // for UNC
    }

    // remove redundant slashes
    return p.replace(/\/\/+/g, '/');
}

function _endsWith(str: string, end: string): boolean {
    return str.slice(-end.length) == end;
}
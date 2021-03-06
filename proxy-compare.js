// symbols
const OWN_KEYS_SYMBOL = Symbol();
const TRACK_MEMO_SYMBOL = Symbol();
const GET_ORIGINAL_SYMBOL = Symbol();
// properties
const AFFECTED_PROPERTY = 'a';
const FROZEN_PROPERTY = 'f';
const PROXY_PROPERTY = 'p';
const PROXY_CACHE_PROPERTY = 'c';
const NEXT_OBJECT_PROPERTY = 'n';
const CHANGED_PROPERTY = 'g';
// get object prototype
const getProto = Object.getPrototypeOf;
const objectsToTrack = new WeakMap();
// check if obj is a plain object or an array
const isObjectToTrack = (obj) => (obj && (objectsToTrack.has(obj)
    ? objectsToTrack.get(obj)
    : (getProto(obj) === Object.prototype || getProto(obj) === Array.prototype)));
// check if it is object
const isObject = (x) => (typeof x === 'object' && x !== null);
// check if frozen
const isFrozen = (obj) => (Object.isFrozen(obj) || (
// Object.isFrozen() doesn't detect non-writable properties
// See: https://github.com/dai-shi/proxy-compare/pull/8
Object.values(Object.getOwnPropertyDescriptors(obj)).some((descriptor) => !descriptor.writable)));
// copy frozen object
const unfreeze = (obj) => {
    if (Array.isArray(obj)) {
        // Arrays need a special way to copy
        return Array.from(obj);
    }
    // For non-array objects, we create a new object keeping the prototype
    // with changing all configurable options (otherwise, proxies will complain)
    const descriptors = Object.getOwnPropertyDescriptors(obj);
    Object.values(descriptors).forEach((desc) => { desc.configurable = true; });
    return Object.create(getProto(obj), descriptors);
};
const createProxyHandler = (origObj, frozen) => {
    let trackObject = false; // for trackMemo
    const recordUsage = (h, key, skipWithOwnKeys) => {
        if (!trackObject) {
            let used = h[AFFECTED_PROPERTY].get(origObj);
            if (!used) {
                used = new Set();
                h[AFFECTED_PROPERTY].set(origObj, used);
            }
            if (!skipWithOwnKeys || !used.has(OWN_KEYS_SYMBOL)) {
                used.add(key);
            }
        }
    };
    const recordObjectAsUsed = (h) => {
        trackObject = true;
        h[AFFECTED_PROPERTY].delete(origObj);
    };
    const handler = {
        [FROZEN_PROPERTY]: frozen,
        get(target, key) {
            if (key === GET_ORIGINAL_SYMBOL) {
                return origObj;
            }
            recordUsage(this, key);
            return createProxy(target[key], this[AFFECTED_PROPERTY], this[PROXY_CACHE_PROPERTY]);
        },
        has(target, key) {
            if (key === TRACK_MEMO_SYMBOL) {
                recordObjectAsUsed(this);
                return true;
            }
            // LIMITATION: We simply record the same as `get`.
            // This means { a: {} } and { a: {} } is detected as changed,
            // if `'a' in obj` is handled.
            recordUsage(this, key);
            return key in target;
        },
        getOwnPropertyDescriptor(target, key) {
            // LIMITATION: We simply record the same as `get`.
            // This means { a: {} } and { a: {} } is detected as changed,
            // if `obj.getOwnPropertyDescriptor('a'))` is handled.
            recordUsage(this, key, true);
            return Object.getOwnPropertyDescriptor(target, key);
        },
        ownKeys(target) {
            recordUsage(this, OWN_KEYS_SYMBOL);
            return Reflect.ownKeys(target);
        },
    };
    if (frozen) {
        handler.set = handler.deleteProperty = () => false;
    }
    return handler;
};
const getOriginalObject = (obj) => (
// unwrap proxy
obj[GET_ORIGINAL_SYMBOL]
    // otherwise
    || obj);
/**
 * Create a proxy.
 *
 * This function will create a proxy at top level and proxy nested objects as you access them,
 * in order to keep track of which properties were accessed via get/has proxy handlers:
 *
 * NOTE: Printing of WeakMap is hard to inspect and not very readable
 * for this purpose you can use the `affectedToPathList` helper.
 *
 * @param {object} obj - Object that will be wrapped on the proxy.
 * @param {WeakMap<object, unknown>} affected -
 * WeakMap that will hold the tracking of which properties in the proxied object were accessed.
 * @param {WeakMap<object, unknown>} [proxyCache] -
 * WeakMap that will help keep referential identity for proxies.
 * @returns {Proxy<object>} - Object wrapped in a proxy.
 *
 * @example
 * import { createProxy } from 'proxy-compare';
 *
 * const original = { a: "1", c: "2", d: { e: "3" } };
 * const affected = new WeakMap();
 * const proxy = createProxy(original, affected);
 *
 * proxy.a // Will mark as used and track its value.
 * // This will update the affected WeakMap with original as key
 * // and a Set with "a"
 *
 * proxy.d // Will mark "d" as accessed to track and proxy itself ({ e: "3" }).
 * // This will update the affected WeakMap with original as key
 * // and a Set with "d"
 */
export const createProxy = (obj, affected, proxyCache) => {
    if (!isObjectToTrack(obj))
        return obj;
    const target = getOriginalObject(obj);
    const frozen = isFrozen(target);
    let proxyHandler = (proxyCache && proxyCache.get(target));
    if (!proxyHandler || proxyHandler[FROZEN_PROPERTY] !== frozen) {
        proxyHandler = createProxyHandler(target, frozen);
        proxyHandler[PROXY_PROPERTY] = new Proxy(frozen ? unfreeze(target) : target, proxyHandler);
        if (proxyCache) {
            proxyCache.set(target, proxyHandler);
        }
    }
    proxyHandler[AFFECTED_PROPERTY] = affected;
    proxyHandler[PROXY_CACHE_PROPERTY] = proxyCache;
    return proxyHandler[PROXY_PROPERTY];
};
const isOwnKeysChanged = (prevObj, nextObj) => {
    const prevKeys = Reflect.ownKeys(prevObj);
    const nextKeys = Reflect.ownKeys(nextObj);
    return prevKeys.length !== nextKeys.length
        || prevKeys.some((k, i) => k !== nextKeys[i]);
};
/**
 * Compare changes on objects.
 *
 * This will compare the affected properties on tracked objects inside the proxy
 * to check if there were any changes made to it,
 * by default if no property was accessed on the proxy it will attempt to do a
 * reference equality check for the objects provided (Object.is(a, b)). If you access a property
 * on the proxy, then isChanged will only compare the affected properties.
 *
 * @param {object} prevObj - The previous object to compare.
 * @param {object} nextObj - Object to compare with the previous one.
 * @param {WeakMap<object, unknown>} affected -
 * WeakMap that holds the tracking of which properties in the proxied object were accessed.
 * @param {WeakMap<object, unknown>} [cache] -
 * WeakMap that holds a cache of the comparisons for better performance with repetitive comparisons,
 * and to avoid infinite loop with circular structures.
 * @returns {boolean} - Boolean indicating if the affected property on the object has changed.
 *
 * @example
 * import { createProxy, isChanged } from 'proxy-compare';
 *
 * const obj = { a: "1", c: "2", d: { e: "3" } };
 * const affected = new WeakMap();
 *
 * const proxy = createProxy(obj, affected);
 *
 * proxy.a
 *
 * isChanged(obj, { a: "1" }, affected) // false
 *
 * proxy.a = "2"
 *
 * isChanged(obj, { a: "1" }, affected) // true
 */
export const isChanged = (prevObj, nextObj, affected, cache) => {
    if (Object.is(prevObj, nextObj)) {
        return false;
    }
    if (!isObject(prevObj) || !isObject(nextObj))
        return true;
    const used = affected.get(getOriginalObject(prevObj));
    if (!used)
        return true;
    if (cache) {
        const hit = cache.get(prevObj);
        if (hit && hit[NEXT_OBJECT_PROPERTY] === nextObj) {
            return hit[CHANGED_PROPERTY];
        }
        // for object with cycles
        cache.set(prevObj, {
            [NEXT_OBJECT_PROPERTY]: nextObj,
            [CHANGED_PROPERTY]: false,
        });
    }
    let changed = null;
    // eslint-disable-next-line no-restricted-syntax
    for (const key of used) {
        const c = key === OWN_KEYS_SYMBOL ? isOwnKeysChanged(prevObj, nextObj)
            : isChanged(prevObj[key], nextObj[key], affected, cache);
        if (c === true || c === false)
            changed = c;
        if (changed)
            break;
    }
    if (changed === null)
        changed = true;
    if (cache) {
        cache.set(prevObj, {
            [NEXT_OBJECT_PROPERTY]: nextObj,
            [CHANGED_PROPERTY]: changed,
        });
    }
    return changed;
};
// explicitly track object with memo
export const trackMemo = (obj) => {
    if (isObjectToTrack(obj)) {
        return TRACK_MEMO_SYMBOL in obj;
    }
    return false;
};
/**
 * Unwrap proxy to get the original object.
 *
 * Used to retrieve the original object used to create the proxy instance with `createProxy`.
 *
 * @param {Proxy<object>} obj -  The proxy wrapper of the originial object.
 * @returns {object | null} - Return either the unwrapped object if exists.
 *
 * @example
 * import { createProxy, getUntracked } from 'proxy-compare';
 *
 * const original = { a: "1", c: "2", d: { e: "3" } };
 * const affected = new WeakMap();
 *
 * const proxy = createProxy(original, affected);
 * const originalFromProxy = getUntracked(proxy)
 *
 * Object.is(original, originalFromProxy) // true
 * isChanged(original, originalFromProxy, affected) // false
 */
export const getUntracked = (obj) => {
    if (isObjectToTrack(obj)) {
        return obj[GET_ORIGINAL_SYMBOL] || null;
    }
    return null;
};
/**
 * Mark object to be tracked.
 *
 * This function marks an object that will be passed into `createProxy`
 * as marked to track or not. By default only Array and Object are marked to track,
 * so this is useful for example to mark a class instance to track or to mark a object
 * to be untracked when creating your proxy.
 *
 * @param obj - Object to mark as tracked or not.
 * @param mark - Boolean indicating whether you want to track this object or not.
 * @returns No return.
 *
 * @example
 * import { createProxy, markToTrack, isChanged } from 'proxy-compare';
 *
 * const nested = { e: "3" }
 *
 * markToTrack(nested, false)
 *
 * const original = { a: "1", c: "2", d: nested };
 * const affected = new WeakMap();
 *
 * const proxy = createProxy(original, affected);
 *
 * proxy.d.e
 *
 * isChanged(original, { d: { e: "3" } }, affected) // true
 */
export const markToTrack = (obj, mark = true) => {
    objectsToTrack.set(obj, mark);
};
// convert affected to path list
export const affectedToPathList = (obj, affected) => {
    const list = [];
    const seen = new WeakSet();
    const walk = (x, path) => {
        if (seen.has(x)) {
            // for object with cycles
            return;
        }
        if (isObject(x)) {
            seen.add(x);
        }
        const used = isObject(x) && affected.get(getOriginalObject(x));
        if (used) {
            used.forEach((key) => {
                walk(x[key], path ? [...path, key] : [key]);
            });
        }
        else if (path) {
            list.push(path);
        }
    };
    walk(obj);
    return list;
};
//# sourceMappingURL=proxy-compare.js.map
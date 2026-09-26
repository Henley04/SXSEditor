'use strict';
let activeScope = null;
const trackedScopes = new WeakMap();
function trackProjectedValue(value, typeName) {
activeScope?.track(value, typeName);
return value;
}
function isObjectLike(value) {
return value !== null && (typeof value === 'object' || typeof value === 'function');
}
function removeTracking(scope, value) {
const scopes = trackedScopes.get(value);
if (!scopes) return;
scopes.delete(scope);
if (scopes.size === 0) trackedScopes.delete(value);
}
function untrackProjectedValue(value) {
const scopes = trackedScopes.get(value);
if (!scopes) return;
for (const scope of [...scopes]) scope.untrack(value);
}
function castProjectedValueOwned(value, iid, typeName) {
let projected;
try { projected = value.cast(iid); }
catch (error) {
try { value.release(); } catch {}
throw error;
}
if (projected !== value) {
try { value.release(); }
catch (error) {
try { projected.release(); } catch {}
throw error;
}
}
return trackProjectedValue(projected, typeName);
}
function castProjectedValueBorrowed(value, iid, typeName) {
return trackProjectedValue(value.cast(iid), typeName);
}
const castProjectedValue = castProjectedValueOwned;
function projectAs(value, type) {
const source = isObjectLike(value) && '_obj' in value ? value._obj : value;
if (!isObjectLike(source)) throw new TypeError('projectAs requires a projected value or wrapper.');
if (!isObjectLike(type) || typeof type._fromNativeBorrowed !== 'function') {
throw new TypeError('projectAs requires a generated runtime class type.');
}
const projected = type._fromNativeBorrowed(source);
if (!isObjectLike(projected) || !('_obj' in projected)) {
throw new TypeError('The generated runtime class returned an invalid projection.');
}
return projected;
}
function releaseProjected(value) {
if (!isObjectLike(value) || !('_obj' in value)) {
throw new TypeError('releaseProjected requires a generated projected wrapper.');
}
const projected = value._obj;
if (!isObjectLike(projected) || typeof projected.release !== 'function') {
throw new TypeError('The projected wrapper does not contain a releasable native value.');
}
projected.release();
untrackProjectedValue(projected);
}
function createProjectedLifetimeScope() {
const previousScope = activeScope;
const registry = new Map();
let disposed = false;
const scope = {
get disposed() { return disposed; },
track(value, typeName) {
if (disposed) throw new Error('Cannot track values in a disposed projection scope.');
if (registry.has(value)) return;
registry.set(value, typeName);
let scopes = trackedScopes.get(value);
if (!scopes) trackedScopes.set(value, scopes = new Set());
scopes.add(scope);
},
untrack(value) {
registry.delete(value);
removeTracking(scope, value);
},
dispose() {
if (disposed) return;
if (activeScope !== scope) throw new Error('Projection lifetime scopes must be disposed in LIFO order.');
let firstError;
for (const [value] of [...registry].reverse()) {
try { value.release(); scope.untrack(value); }
catch (error) { firstError ??= error; }
}
if (firstError !== undefined) throw firstError;
disposed = true;
activeScope = previousScope;
},
};
activeScope = scope;
return scope;
}
exports.trackProjectedValue = trackProjectedValue;
exports.castProjectedValue = castProjectedValue;
exports.castProjectedValueOwned = castProjectedValueOwned;
exports.castProjectedValueBorrowed = castProjectedValueBorrowed;
exports.projectAs = projectAs;
exports.releaseProjected = releaseProjected;
exports.createProjectedLifetimeScope = createProjectedLifetimeScope;

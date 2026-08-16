// tests/racer-reverse.test.js
/* global describe, test, expect, beforeEach, afterEach, jest */
'use strict';

// Integration test for the reverse-start (OCS) feature. It drives the real
// plugin (index.js) through a mocked Signal K `app`, so it exercises the
// actual processPosition / ocs logic. Requires geolib + uuid to be installed.

// Builds a minimal Signal K `app` mock. `selfPaths` maps a path to the object
// returned by getSelfPath (i.e. { value: ... }).
function createMockApp(selfPaths) {
    const deltas = [];        // flattened { path, value } from handleMessage
    const putHandlers = {};   // path -> handler(ctx, path, args, callback)
    let positionCb = null;    // captured navigation.position delta callback

    const app = {
        selfId: 'self',
        debug: () => {},
        error: () => {},
        getSelfPath: (p) => selfPaths[p],
        handleMessage: (context, delta) => {
            (delta.updates || []).forEach((u) => {
                (u.values || []).forEach((v) => deltas.push(v));
            });
        },
        subscriptionmanager: {
            subscribe: (subscription, unsubscribes, onError, onDelta) => {
                const first = subscription.subscribe && subscription.subscribe[0];
                if (first && first.path === 'navigation.position') {
                    positionCb = onDelta;
                }
            }
        },
        registerPutHandler: (context, path, handler) => {
            putHandlers[path] = handler;
        },
        resourcesApi: {
            listResources: async () => ({}),
            setResource: async () => {},
            getResource: async () => ({})
        }
    };

    return {app, deltas, putHandlers, getPositionCb: () => positionCb};
}

describe('reverse start (OCS) - index.js integration', () => {
    // Standard line: when crossing the line toward the course, the committee
    // boat (stb end) is to starboard and the pin (port end) is to port.
    // For that to hold in this test the course is to the north, which places the
    // pin to the west and the committee boat to the east.
    const port = {latitude: 47.6800, longitude: -122.4010}; // pin (port end) - west
    const stb = {latitude: 47.6800, longitude: -122.3990};  // committee boat (stb end) - east
    // Boat on the pre-start (south) side, near the middle of the line.
    const bowSouth = {latitude: 47.6795, longitude: -122.4000};

    const options = {
        startLinePort: 'startPin',
        startLineStb: 'startBoat',
        timer: 300,
        period: 1000,
        minSog: 1.0,
        maxDistance: 2000,
        maxSamples: 600,
        percentile: 0.9,
        lines: []
    };

    let ctx;
    let plugin;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.resetModules(); // reset racer.js module-level VMG state between tests
        ctx = createMockApp({
            'navigation.racing.startLineStb': {value: stb},
            'navigation.racing.startLinePort': {value: port},
            'navigation.position': {value: bowSouth},
            'navigation.courseOverGroundTrue': {value: 0}, // heading ~ north
            'navigation.speedOverGround': {value: 3}
        });
        plugin = require('../index')(ctx.app);
        plugin.start(options);
    });

    afterEach(() => {
        if (plugin && plugin.stop) plugin.stop();
        jest.clearAllTimers();
        jest.useRealTimers();
    });

    // Most recent value published for a path (null is preserved, undefined means "not sent").
    function latest(path) {
        for (let i = ctx.deltas.length - 1; i >= 0; i--) {
            if (ctx.deltas[i].path === path) return ctx.deltas[i].value;
        }
        return undefined;
    }

    function callPut(path, args) {
        return ctx.putHandlers[path]('vessels.self', path, args, () => {});
    }

    async function startTimer() {
        await callPut('navigation.racing.setStartTime', {command: 'start'});
    }

    function feedPosition(pos) {
        ctx.getPositionCb()({updates: [{values: [{path: 'navigation.position', value: pos}]}]});
    }

    test('normal mode: a pre-start boat gets a positive DTS and a numeric TTB', async () => {
        await startTimer();
        ctx.deltas.length = 0;
        feedPosition(bowSouth);

        expect(latest('navigation.racing.distanceStartline')).toBeGreaterThan(0);
        expect(typeof latest('navigation.racing.timeToBurn')).toBe('number');
    });

    test('reverse mode: DTS sign flips negative and TTB is suppressed', async () => {
        await startTimer();
        ctx.deltas.length = 0;

        await callPut('navigation.racing.setReverseStart', {reverse: true});

        expect(latest('navigation.racing.reverseStart')).toBe(true);
        expect(latest('navigation.racing.distanceStartline')).toBeLessThan(0);
        expect(latest('navigation.racing.timeToBurn')).toBeNull();
    });

    test('toggling reverse back restores the normal sign and TTB', async () => {
        await startTimer();
        await callPut('navigation.racing.setReverseStart', {reverse: true});

        ctx.deltas.length = 0;
        await callPut('navigation.racing.setReverseStart', {reverse: false});

        expect(latest('navigation.racing.reverseStart')).toBe(false);
        expect(latest('navigation.racing.distanceStartline')).toBeGreaterThan(0);
        expect(typeof latest('navigation.racing.timeToBurn')).toBe('number');
    });

    test('reverse exactly negates the normal signed distance for the same position', async () => {
        feedPosition(bowSouth);
        const normal = latest('navigation.racing.distanceStartline');

        await callPut('navigation.racing.setReverseStart', {reverse: true});
        const reversed = latest('navigation.racing.distanceStartline');

        expect(reversed).toBeCloseTo(-normal, 1);
    });

    test('setReverseStart rejects a non-boolean payload', async () => {
        const result = await callPut('navigation.racing.setReverseStart', {reverse: 'yes'});
        expect(result.state).toBe('FAILURE');
        expect(result.statusCode).toBe(400);
    });
});

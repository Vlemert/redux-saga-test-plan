// @flow
import { effects, runSaga, utils } from 'redux-saga';
import SagaTestError from './SagaTestError';
import { findIndex, splitAt } from './utils/array';
import Map from './utils/Map';
import ArraySet from './utils/ArraySet';
import serializeEffect from './serializeEffect';
import { warn } from './utils/logging';
import { delay, schedule } from './utils/async';
import identity from './utils/identity';
import reportActualEffects from './reportActualEffects';

import {
  ACTION_CHANNEL,
  CALL,
  CPS,
  FORK,
  NONE,
  PROMISE,
  PUT,
  RACE,
  SELECT,
  TAKE,
} from './keys';

const { asEffect, is } = utils;

const INIT_ACTION = { type: '@@redux-saga-test-plan/INIT' };

function extractState(reducer: Reducer, initialState?: any): any {
  return initialState || reducer(undefined, INIT_ACTION);
}

export default function expectSaga(generator: Function, ...sagaArgs: mixed[]): ExpectApi {
  const effectStores = {
    [TAKE]: new ArraySet(),
    [PUT]: new ArraySet(),
    [RACE]: new ArraySet(),
    [CALL]: new ArraySet(),
    [CPS]: new ArraySet(),
    [FORK]: new ArraySet(),
    [SELECT]: new ArraySet(),
    [ACTION_CHANNEL]: new ArraySet(),
    [PROMISE]: new ArraySet(),
  };

  const expectations = [];
  const queuedActions = [];
  const listeners = [];
  const forkedTasks = [];
  const outstandingForkEffects = new Map();
  const outstandingActionChannelEffects = new Map();
  const channelsToPatterns = new Map();

  let stopDirty = false;

  let iterator;
  let mainTask;
  let mainTaskPromise;

  let storeState: any;

  function defaultReducer(state = storeState) {
    return state;
  }

  let reducer: Reducer = defaultReducer;

  function getAllPromises(): Promise<*> {
    return new Promise(resolve => {
      Promise.all([
        ...effectStores[PROMISE].values(),
        ...forkedTasks.map(task => task.done),
        mainTaskPromise,
      ]).then(() => {
        if (stopDirty) {
          stopDirty = false;
          resolve(getAllPromises());
        }
        resolve();
      });
    });
  }

  function addForkedTask(task: Task): void {
    stopDirty = true;
    forkedTasks.push(task);
  }

  function cancelMainTask(
    timeout: number,
    silenceTimeout: boolean,
    timedOut: boolean,
  ): Promise<*> {
    if (!silenceTimeout && timedOut) {
      warn(`Saga exceeded async timeout of ${timeout}ms`);
    }

    mainTask.cancel();

    return mainTaskPromise;
  }

  function scheduleStop(timeout: Timeout | TimeoutConfig): Promise<*> {
    let promise = schedule(getAllPromises).then(() => false);
    let silenceTimeout = false;
    let timeoutLength: ?Timeout;

    if (typeof timeout === 'number') {
      timeoutLength = timeout;
    } else if (typeof timeout === 'object') {
      silenceTimeout = timeout.silenceTimeout === true;

      if ('timeout' in timeout) {
        timeoutLength = timeout.timeout;
      } else {
        timeoutLength = expectSaga.DEFAULT_TIMEOUT;
      }
    }

    if (typeof timeoutLength === 'number') {
      promise = Promise.race([
        promise,
        delay(timeoutLength).then(() => true),
      ]);
    }

    return promise.then(
      timedOut => schedule(cancelMainTask, [
        timeoutLength,
        silenceTimeout,
        timedOut,
      ]),
    );
  }

  function queueAction(action: Action): void {
    queuedActions.push(action);
  }

  function notifyListeners(action: Action): void {
    listeners.forEach((listener) => {
      listener(action);
    });
  }

  function dispatch(action: Action): any {
    storeState = reducer(storeState, action);
    notifyListeners(action);
    return action;
  }

  function associateChannelWithPattern(channel: Object, pattern: any): void {
    channelsToPatterns.set(channel, pattern);
  }

  function getDispatchableActions(effect: Object): Array<Action> {
    const type = effect.pattern || channelsToPatterns.get(effect.channel);
    const index = findIndex(queuedActions, a => a.type === type);

    if (index > -1) {
      const actions = queuedActions.splice(0, index + 1);
      return actions;
    }

    return [];
  }

  function parseEffect(effect: Object): string {
    switch (true) {
      case is.promise(effect):
        return PROMISE;

      case is.notUndef(asEffect.take(effect)):
        return TAKE;

      case is.notUndef(asEffect.put(effect)):
        return PUT;

      case is.notUndef(asEffect.race(effect)):
        return RACE;

      case is.notUndef(asEffect.call(effect)):
        return CALL;

      case is.notUndef(asEffect.cps(effect)):
        return CPS;

      case is.notUndef(asEffect.fork(effect)):
        return FORK;

      case is.notUndef(asEffect.select(effect)):
        return SELECT;

      case is.notUndef(asEffect.actionChannel(effect)):
        return ACTION_CHANNEL;

      default:
        return NONE;
    }
  }

  function processEffect(event: Object): void {
    const effectType = parseEffect(event.effect);

    // Using string literal for flow
    if (effectType === 'NONE') {
      return;
    }

    const effectStore = effectStores[effectType];

    effectStore.add(event.effect);

    switch (effectType) {
      case FORK: {
        const effect = asEffect.fork(event.effect);
        outstandingForkEffects.set(event.effectId, effect);
        break;
      }

      case TAKE: {
        const effect = asEffect.take(event.effect);
        const actions = getDispatchableActions(effect);

        const [reducerActions, [sagaAction]] = splitAt(actions, -1);

        reducerActions.forEach((action) => {
          dispatch(action);
        });

        if (sagaAction) {
          schedule(() => dispatch(sagaAction));
        }

        break;
      }

      case ACTION_CHANNEL: {
        const effect = asEffect.actionChannel(event.effect);
        outstandingActionChannelEffects.set(event.effectId, effect);
        break;
      }

      // no default
    }
  }

  const io = {
    subscribe(listener: Function): Function {
      listeners.push(listener);

      return () => {
        const index = listeners.indexOf(listener);
        listeners.splice(index, 1);
      };
    },

    dispatch,

    getState(): any {
      return storeState;
    },

    sagaMonitor: {
      effectTriggered(event: Object): void {
        processEffect(event);
      },

      effectResolved(effectId: number, value: any): void {
        const forkEffect = outstandingForkEffects.get(effectId);

        if (forkEffect) {
          addForkedTask(value);
          return;
        }

        const actionChannelEffect = outstandingActionChannelEffects.get(effectId);

        if (actionChannelEffect) {
          associateChannelWithPattern(value, actionChannelEffect.pattern);
        }
      },

      effectRejected() {},
      effectCancelled() {},
    },
  };

  const api = {
    run,
    withState,
    withReducer,
    dispatch: apiDispatch,

    actionChannel: createEffectTesterFromEffects('actionChannel', ACTION_CHANNEL),
    apply: createEffectTesterFromEffects('apply', CALL),
    call: createEffectTesterFromEffects('call', CALL),
    cps: createEffectTesterFromEffects('cps', CPS),
    fork: createEffectTesterFromEffects('fork', FORK),
    put: createEffectTesterFromEffects('put', PUT),
    race: createEffectTesterFromEffects('race', RACE),
    select: createEffectTesterFromEffects('select', SELECT),
    spawn: createEffectTesterFromEffects('spawn', FORK),
    take: createEffectTesterFromEffects('take', TAKE),
  };

  api.put.resolve = createEffectTester('put.resolve', PUT, effects.put.resolve);
  api.take.maybe = createEffectTester('take.maybe', TAKE, effects.take.maybe);

  function checkExpectations(): void {
    expectations.forEach(({ effectName, expectedEffect, store, storeKey }) => {
      const deleted = store.delete(expectedEffect);

      if (!deleted) {
        const serializedEffect = serializeEffect(expectedEffect, storeKey);
        let errorMessage = `\n${effectName} expectation unmet:` +
                           `\n\nExpected\n--------\n${serializedEffect}\n`;

        errorMessage += reportActualEffects(store, storeKey, effectName);

        throw new SagaTestError(errorMessage);
      }
    });
  }

  function apiDispatch(action: Action): ExpectApi {
    queueAction(action);
    return api;
  }

  function start(): ExpectApi {
    iterator = generator(...sagaArgs);

    mainTask = runSaga(iterator, io);

    mainTaskPromise = mainTask.done
      .then(checkExpectations)
      // Pass along the error instead of rethrowing or allowing to
      // bubble up to avoid PromiseRejectionHandledWarning
      .catch(identity);

    return api;
  }

  function stop(timeout: Timeout | TimeoutConfig): Promise<*> {
    return scheduleStop(timeout).then((err) => {
      if (err) {
        throw err;
      }
    });
  }

  function run(
    timeout?: Timeout | TimeoutConfig = expectSaga.DEFAULT_TIMEOUT,
  ): Promise<*> {
    start();
    return stop(timeout);
  }

  function withState(state: any): ExpectApi {
    storeState = state;
    return api;
  }

  function withReducer(newReducer: Reducer, initialState?: any): ExpectApi {
    reducer = newReducer;

    storeState = extractState(newReducer, initialState);

    return api;
  }

  function createEffectTester(
    effectName: string,
    storeKey: string,
    effectCreator: Function,
  ): Function {
    return (...args: mixed[]) => {
      const expectedEffect = effectCreator(...args);

      expectations.push({
        effectName,
        expectedEffect,
        storeKey,
        store: effectStores[storeKey],
      });

      return api;
    };
  }

  function createEffectTesterFromEffects(
    effectName: string,
    storeKey: string,
  ): Function {
    return createEffectTester(effectName, storeKey, effects[effectName]);
  }

  return api;
}

expectSaga.DEFAULT_TIMEOUT = 250;

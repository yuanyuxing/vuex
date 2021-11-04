import applyMixin from './mixin'
import devtoolPlugin from './plugins/devtool'
import ModuleCollection from './module/module-collection'
import { forEachValue, isObject, isPromise, assert, partial } from './util'

let Vue // bind on install

export class Store {
  constructor (options = {}) {
    // Auto install if it is not done yet and `window` has `Vue`.
    // To allow users to avoid auto-installation in some cases,
    // this code should be placed here. See #731
    if (!Vue && typeof window !== 'undefined' && window.Vue) {
      install(window.Vue)
    }

    const {
      plugins = [],
      strict = false
    } = options

    // store internal state
     /* 用来判断严格模式下是否是用mutation修改state的 */
    this._committing = false
    /* 存放action */
    this._actions = Object.create(null)  // {}
    /* 存放action订阅者 */
    this._actionSubscribers = []
    /* 存放mutation */
    this._mutations = Object.create(null) // {}
    /* 存放getter */
    this._wrappedGetters = Object.create(null) // {}
    /* module收集器 */
    this._modules = new ModuleCollection(options)
    /* 根据namespace存放module */
    this._modulesNamespaceMap = Object.create(null) // {}
    /* 存放mutation订阅者 */
    this._subscribers = []
    /* 用以实现Watch的Vue实例 */
    this._watcherVM = new Vue()
    this._makeLocalGettersCache = Object.create(null) //{}

    // bind commit and dispatch to self
    // 无法在外部改变this实例，this只有指向Store
    const store = this
    const { dispatch, commit } = this
    this.dispatch = function boundDispatch (type, payload) {
      return dispatch.call(store, type, payload)
    }
    this.commit = function boundCommit (type, payload, options) {
      return commit.call(store, type, payload, options)
    }

    // strict mode
    /*严格模式(使 Vuex store 进入严格模式，在严格模式下，任何 mutation 处理函数以外修改 Vuex state 都会抛出错误)*/
    this.strict = strict

    const state = this._modules.root.state

    // init root module.  --init根模块
    // this also recursively registers all sub-modules  --递归地注册所有子模块
    // and collects all module getters inside this._wrappedGetters --并在此内部收集所有模块到wrappedGetters 
    /*初始化根module，这也同时递归注册了所有子module，收集所有module的getter到_wrappedGetters中去，this._modules.root代表根module才独有保存的Module对象*/
    installModule(this, state, [], this._modules.root)

    // initialize the store vm, which is responsible for the reactivity
    // (also registers _wrappedGetters as computed properties)
    /* 通过vm重设store，新建Vue对象使用Vue内部的响应式实现注册state以及computed */
    resetStoreVM(this, state)

    // apply plugins  应用插件
    plugins.forEach(plugin => plugin(this))

    // 判断是否有devtools工具
    const useDevtools = options.devtools !== undefined ? options.devtools : Vue.config.devtools
    if (useDevtools) {
      devtoolPlugin(this)
    }
  }

  get state () {
    return this._vm._data.$$state
  }

  // 无法设置state
  set state (v) {
    if (__DEV__) {
      assert(false, `use store.replaceState() to explicit replace store state.`)
    }
  }

  // store.commit 
  //在commit结束以后则会调用这些_subscribers中的订阅者，这个订阅者模式提供给外部一个监视state变化的可能。state通过mutation改变时，可以有效补获这些变化。
  commit (_type, _payload, _options) {
    // check object-style commit
    const {
      type,
      payload,
      options
    } = unifyObjectStyle(_type, _payload, _options)

    const mutation = { type, payload }
    const entry = this._mutations[type]
    if (!entry) {
      if (__DEV__) {
        console.error(`[vuex] unknown mutation type: ${type}`)
      }
      return
    }
    /* 执行mutation中的所有方法 */
    this._withCommit(() => {
      entry.forEach(function commitIterator (handler) {
        handler(payload)
      })
    })

    /* 通知所有订阅者 */
    this._subscribers
      .slice() // shallow copy to prevent iterator invalidation if subscriber synchronously calls unsubscribe
      .forEach(sub => sub(mutation, this.state))

    if (
      __DEV__ &&
      options && options.silent
    ) {
      console.warn(
        `[vuex] mutation type: ${type}. Silent option has been removed. ` +
        'Use the filter functionality in the vue-devtools'
      )
    }
  }

  // store.dispatch 
  dispatch (_type, _payload) {
    // check object-style dispatch
    const {
      type,
      payload
    } = unifyObjectStyle(_type, _payload)

    const action = { type, payload }
    const entry = this._actions[type]
    if (!entry) {
      if (__DEV__) {
        console.error(`[vuex] unknown action type: ${type}`)
      }
      return
    }

    try {
      this._actionSubscribers
        .slice() // shallow copy to prevent iterator invalidation if subscriber synchronously calls unsubscribe
        .filter(sub => sub.before)
        .forEach(sub => sub.before(action, this.state))
    } catch (e) {
      if (__DEV__) {
        console.warn(`[vuex] error in before action subscribers: `)
        console.error(e)
      }
    }

    /* 是数组则包装Promise形成一个新的Promise，只有一个则直接返回第0个 */
    const result = entry.length > 1
      ? Promise.all(entry.map(handler => handler(payload)))
      : entry[0](payload)

    return new Promise((resolve, reject) => {
      result.then(res => {
        try {
          this._actionSubscribers
            .filter(sub => sub.after)
            .forEach(sub => sub.after(action, this.state))
        } catch (e) {
          if (__DEV__) {
            console.warn(`[vuex] error in after action subscribers: `)
            console.error(e)
          }
        }
        resolve(res)
      }, error => {
        try {
          this._actionSubscribers
            .filter(sub => sub.error)
            .forEach(sub => sub.error(action, this.state, error))
        } catch (e) {
          if (__DEV__) {
            console.warn(`[vuex] error in error action subscribers: `)
            console.error(e)
          }
        }
        reject(error)
      })
    })
  }

  subscribe (fn, options) {
    return genericSubscribe(fn, this._subscribers, options)
  }

  subscribeAction (fn, options) {
    const subs = typeof fn === 'function' ? { before: fn } : fn
    return genericSubscribe(subs, this._actionSubscribers, options)
  }

  watch (getter, cb, options) {
    if (__DEV__) {
      assert(typeof getter === 'function', `store.watch only accepts a function.`)
    }
    return this._watcherVM.$watch(() => getter(this.state, this.getters), cb, options)
  }

  // 重新设置state
  replaceState (state) {
    this._withCommit(() => {
      this._vm._data.$$state = state
    })
  }

  /* 注册一个动态module，当业务进行异步加载的时候，可以通过该接口进行注册动态module */
  registerModule (path, rawModule, options = {}) {
    if (typeof path === 'string') path = [path]

    if (__DEV__) {
      assert(Array.isArray(path), `module path must be a string or an Array.`)
      assert(path.length > 0, 'cannot register the root module by using registerModule.')
    }

    this._modules.register(path, rawModule)
    installModule(this, this.state, path, this._modules.get(path), options.preserveState)
    // reset store to update getters...
    resetStoreVM(this, this.state)
  }

   /* 注销一个动态module */
  unregisterModule (path) {
    if (typeof path === 'string') path = [path]

    if (__DEV__) {
      assert(Array.isArray(path), `module path must be a string or an Array.`)
    }

    this._modules.unregister(path)
    this._withCommit(() => {
      /* 获取父级的state */
      const parentState = getNestedState(this.state, path.slice(0, -1))
      /* 从父级中删除 */
      Vue.delete(parentState, path[path.length - 1])
    })
    resetStore(this)
  }

  // 判断是否有这个path的module
  hasModule (path) {
    if (typeof path === 'string') path = [path]

    if (__DEV__) {
      assert(Array.isArray(path), `module path must be a string or an Array.`)
    }

    // 判断module是否有注册
    return this._modules.isRegistered(path)
  }

  hotUpdate (newOptions) {
    this._modules.update(newOptions)
    resetStore(this, true)
  }

  /* 
  * 调用withCommit修改state的值时会将store的committing值置为true，内部会有断言检查该值，
  * 在严格模式下只允许使用mutation来修改store中的值，而不允许直接修改store的数值 
  */
  _withCommit (fn) {
    const committing = this._committing
    this._committing = true
    fn()
    this._committing = committing
  }
}

/* 注册一个订阅函数，返回取消订阅的函数 */
function genericSubscribe (fn, subs, options) {
  if (subs.indexOf(fn) < 0) {
    options && options.prepend
      ? subs.unshift(fn)
      : subs.push(fn)
  }
  return () => {
    const i = subs.indexOf(fn)
    if (i > -1) {
      subs.splice(i, 1)
    }
  }
}

/* 重制store */
function resetStore (store, hot) {
  store._actions = Object.create(null)
  store._mutations = Object.create(null)
  store._wrappedGetters = Object.create(null)
  store._modulesNamespaceMap = Object.create(null)
  const state = store.state
  // init all modules
  installModule(store, state, [], store._modules.root, true)
  // reset vm
  resetStoreVM(store, state, hot)
}

/* 通过vm重设store，新建Vue对象使用Vue内部的响应式实现注册state以及computed */
// 为vue响应式更新使用
function resetStoreVM (store, state, hot) {
  const oldVm = store._vm

  // bind store public getters
  store.getters = {}
  // reset local getters cache
  store._makeLocalGettersCache = Object.create(null)
  const wrappedGetters = store._wrappedGetters
  const computed = {}
  forEachValue(wrappedGetters, (fn, key) => {
    // use computed to leverage its lazy-caching mechanism
    // direct inline function use will lead to closure preserving oldVm.
    // using partial to return function with only arguments preserved in closure environment.
    computed[key] = partial(fn, store)
    Object.defineProperty(store.getters, key, {
      get: () => store._vm[key],
      enumerable: true // for local getters
    })
  })

  // use a Vue instance to store the state tree
  // suppress warnings just in case the user has added
  // some funky global mixins
  const silent = Vue.config.silent
  /* Vue.config.silent暂时设置为true的目的是在new一个Vue实例的过程中不会报出一切警告 */
  Vue.config.silent = true
  store._vm = new Vue({
    data: {
      $$state: state
    },
    computed
  })
  Vue.config.silent = silent

  // enable strict mode for new vm
  /**Vuex的Store构造类的option有一个strict的参数，可以控制Vuex执行严格模式，严格模式下，所有修改state的操作必须通过mutation实现，否则会抛出错误 */
  if (store.strict) {
    enableStrictMode(store)
  }

  if (oldVm) {
    /* 解除旧vm的state的引用，以及销毁旧的Vue对象 */
    if (hot) {
      // dispatch changes in all subscribed watchers
      // to force getter re-evaluation for hot reloading.
      store._withCommit(() => {
        oldVm._data.$$state = null
      })
    }
    Vue.nextTick(() => oldVm.$destroy())
  }
}

function installModule (store, rootState, path, module, hot) {
  const isRoot = !path.length  // 判断是不是root modelue
  const namespace = store._modules.getNamespace(path) // 根路径为 ''， 'r2' 'r2/r3'

  // register in namespace map  => 根据路径映射module
  if (module.namespaced) { // namespaced为true才收集
    if (store._modulesNamespaceMap[namespace] && __DEV__) {
      console.error(`[vuex] duplicate namespace ${namespace} for the namespaced module ${path.join('/')}`)
    }
    store._modulesNamespaceMap[namespace] = module
  }

  // set state
  // 设置子模块的 state 设置到父模块的 state 中去，这也是为什么我们可以通过这种方式来获取子模块的 state 
  if (!isRoot && !hot) {
    const parentState = getNestedState(rootState, path.slice(0, -1))
    const moduleName = path[path.length - 1]
    store._withCommit(() => {
      if (__DEV__) {
        if (moduleName in parentState) {
          console.warn(
            `[vuex] state field "${moduleName}" was overridden by a module with the same name at "${path.join('.')}"`
          )
        }
      }
      // 为各个子模块state设置响应
      Vue.set(parentState, moduleName, module.state)
    })
  }

  // 获取当前module的上下文，如果没有设置namespace，那么上下文就只有root
  const local = module.context = makeLocalContext(store, namespace, path)

  module.forEachMutation((mutation, key) => {
    const namespacedType = namespace + key
    registerMutation(store, namespacedType, mutation, local)
  })

  module.forEachAction((action, key) => {
    const type = action.root ? key : namespace + key
    const handler = action.handler || action
    registerAction(store, type, handler, local)
  })

  module.forEachGetter((getter, key) => {
    const namespacedType = namespace + key
    registerGetter(store, namespacedType, getter, local)
  })

  module.forEachChild((child, key) => {
    installModule(store, rootState, path.concat(key), child, hot)
  })
}

/**
 * make localized dispatch, commit, getters and state
 * if there is no namespace, just use root ones
 */
function makeLocalContext (store, namespace, path) {
  const noNamespace = namespace === ''

  const local = {
    dispatch: noNamespace ? store.dispatch : (_type, _payload, _options) => {
      const args = unifyObjectStyle(_type, _payload, _options)
      const { payload, options } = args
      let { type } = args

      if (!options || !options.root) {
        type = namespace + type
        if (__DEV__ && !store._actions[type]) {
          console.error(`[vuex] unknown local action type: ${args.type}, global type: ${type}`)
          return
        }
      }

      return store.dispatch(type, payload)
    },

    commit: noNamespace ? store.commit : (_type, _payload, _options) => {
      const args = unifyObjectStyle(_type, _payload, _options)
      const { payload, options } = args
      let { type } = args

      if (!options || !options.root) {
        type = namespace + type
        if (__DEV__ && !store._mutations[type]) {
          console.error(`[vuex] unknown local mutation type: ${args.type}, global type: ${type}`)
          return
        }
      }

      store.commit(type, payload, options)
    }
  }

  // getters and state object must be gotten lazily
  // because they will be changed by vm update
  Object.defineProperties(local, {
    getters: {
      get: noNamespace
        ? () => store.getters
        : () => makeLocalGetters(store, namespace)
    },
    state: {
      get: () => getNestedState(store.state, path)
    }
  })

  return local
}

function makeLocalGetters (store, namespace) {
  if (!store._makeLocalGettersCache[namespace]) {
    const gettersProxy = {}
    const splitPos = namespace.length
    Object.keys(store.getters).forEach(type => {
      // skip if the target getter is not match this namespace
      if (type.slice(0, splitPos) !== namespace) return

      // extract local getter type
      const localType = type.slice(splitPos)

      // Add a port to the getters proxy.
      // Define as getter property because
      // we do not want to evaluate the getters in this time.
      Object.defineProperty(gettersProxy, localType, {
        get: () => store.getters[type],
        enumerable: true
      })
    })
    store._makeLocalGettersCache[namespace] = gettersProxy
  }

  return store._makeLocalGettersCache[namespace]
}

function registerMutation (store, type, handler, local) {
  const entry = store._mutations[type] || (store._mutations[type] = [])
  entry.push(function wrappedMutationHandler (payload) {
    handler.call(store, local.state, payload)
  })
}

/**
 * 注册 action
 * @param {*} store 
 * @param {*} type 
 * @param {*} handler 
 * @param {*} local 
 */
function registerAction (store, type, handler, local) {
  const entry = store._actions[type] || (store._actions[type] = [])
  entry.push(function wrappedActionHandler (payload) {
    let res = handler.call(store, {
      dispatch: local.dispatch,
      commit: local.commit,
      getters: local.getters,
      state: local.state,
      rootGetters: store.getters,
      rootState: store.state
    }, payload)
    if (!isPromise(res)) {
      res = Promise.resolve(res)
    }
    if (store._devtoolHook) {
      return res.catch(err => {
        store._devtoolHook.emit('vuex:error', err)
        throw err
      })
    } else {
      return res
    }
  })
}

/**
 * 注册 getter
 * @param {*} store 
 * @param {*} type 
 * @param {*} rawGetter 
 * @param {*} local 
 * @returns 
 */
function registerGetter (store, type, rawGetter, local) {
  if (store._wrappedGetters[type]) {
    if (__DEV__) {
      console.error(`[vuex] duplicate getter key: ${type}`)
    }
    return
  }
  store._wrappedGetters[type] = function wrappedGetter (store) {
    return rawGetter(
      local.state, // local state
      local.getters, // local getters
      store.state, // root state
      store.getters // root getters
    )
  }
}

/**
 * 在严格模式下，Vuex会利用vm的$watch方法来观察$$state，也就是Store的state，在它被修改的时候进入回调。
 * 回调中只有一句话，用assert断言来检测store._committing，当store._committing为false的时候会触发断言，抛出异常
 */
function enableStrictMode (store) {
  store._vm.$watch(function () { return this._data.$$state }, () => {
    if (__DEV__) {
      assert(store._committing, `do not mutate vuex store state outside mutation handlers.`)
    }
  }, { deep: true, sync: true })
}

/**
 * 获取嵌套的state
 * for example： 数组['k1','k2'] => state[k1][k2] 
 * @param {*} state 
 * @param {*} path 
 * @returns 
 */
function getNestedState (state, path) {
  return path.reduce((state, key) => state[key], state)
}

function unifyObjectStyle (type, payload, options) {
  if (isObject(type) && type.type) {
    options = payload
    payload = type
    type = type.type
  }

  if (__DEV__) {
    assert(typeof type === 'string', `expects string as the type, but found ${typeof type}.`)
  }

  return { type, payload, options }
}

/**
 * vue 插件使用  Vue.use(Vuex)后调用
 * @param {} _Vue 
 * @returns 
 */
export function install (_Vue) {
  if (Vue && _Vue === Vue) {
    if (__DEV__) {
      console.error(
        '[vuex] already installed. Vue.use(Vuex) should be called only once.'
      )
    }
    return
  }
  Vue = _Vue
  applyMixin(Vue)
}

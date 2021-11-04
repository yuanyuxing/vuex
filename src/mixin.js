export default function (Vue) {
  // 获取version的主要版本，例如 3.6.2 => 3
  const version = Number(Vue.version.split('.')[0])

  if (version >= 2) {
    // vue2版本以上的在每个vue实例里都在beforeCreate调用的vuexInit
    Vue.mixin({ beforeCreate: vuexInit })
  } else {
    // override init and inject vuex init procedure
    // for 1.x backwards compatibility.

    // vue1版本重写的_init方法(aop方式)
    const _init = Vue.prototype._init
    Vue.prototype._init = function (options = {}) {
      options.init = options.init
        ? [vuexInit].concat(options.init)
        : vuexInit
      _init.call(this, options)
    }
  }

  /**
   * Vuex init hook, injected into each instances init hooks list.
   */

  /**
   * vuexInit会尝试从options中获取store，如果当前组件是根组件（Root节点），则options中会存在store，直接获取赋值给$store即可。
   * 如果当前组件非根组件，则通过options中的parent获取父组件的$store引用。
   * 这样一来，所有的组件都获取到了同一份内存地址的Store实例，于是我们可以在每一个组件中通过this.$store愉快地访问全局的Store实例了。
   */
  function vuexInit () {
    const options = this.$options
    // store injection
    if (options.store) {
      /*存在store其实代表的就是Root节点，直接执行store（function时）或者使用store（非function）*/
      this.$store = typeof options.store === 'function'
        ? options.store()
        : options.store
    } else if (options.parent && options.parent.$store) {
      /*子组件直接从父组件中获取$store，这样就保证了所有组件都公用了全局的同一份store*/
      this.$store = options.parent.$store
    }
  }
}

// A separate script file, so error stacks carry in-app frames from a real URL.
(function () {
  function validateOrder(order) {
    if (!order.items.length) throw new Error('fx:external thrown from assets/lib.js');
  }
  function submitOrder() {
    validateOrder({ items: [] });
  }
  window.fxLib = {
    explode: function explode() {
      submitOrder();
    },
  };
})();

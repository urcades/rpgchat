const EventEmitter = require('events');
class EventBus extends EventEmitter {}
const eventBus = new EventBus();
module.exports = eventBus;
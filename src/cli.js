export const COMMANDS = Object.freeze([
  'order normal', 'order vip', 'bot add', 'bot remove', 'status', 'help', 'quit',
]);

/** Parse only the case-sensitive R3 vocabulary; parsing never mutates a session. */
export function parseCommand(line) {
  if (typeof line !== 'string' || !line.trim()) {
    return {op:'invalid', reasonCode:'EMPTY_COMMAND'};
  }
  const command = line.trim().split(/\s+/u).join(' ');
  switch (command) {
    case 'order normal': return {op:'order', customerClass:'NORMAL'};
    case 'order vip': return {op:'order', customerClass:'VIP'};
    case 'bot add': return {op:'bot-add'};
    case 'bot remove': return {op:'bot-remove'};
    case 'status': return {op:'status'};
    case 'help': return {op:'help'};
    case 'quit': return {op:'quit'};
    default: return {op:'invalid', reasonCode:'UNSUPPORTED_COMMAND'};
  }
}

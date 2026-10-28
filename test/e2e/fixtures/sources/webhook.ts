/*
 * The webhook builtin as a consumer would enable it. allowedSenders is the
 * source-local gate: 'dev' is the identity every e2e
 * scenario POSTs with; strangers must get 403.
 */
import { webhook } from 'auto-channels/builtins'

export default webhook({ allowedSenders: ['dev'] })

/*
 * The filedrop builtin, zero-config: emits the contents of any file dropped
 * into ../dropbox/ (FILEDROP_DIR env to change it), or configure inline —
 * filedrop({ dir: '/somewhere/else' }).
 * This one-line file is all it takes to enable a builtin (see _starter.ts).
 */
import { filedrop } from 'auto-channels/builtins'

export default filedrop()

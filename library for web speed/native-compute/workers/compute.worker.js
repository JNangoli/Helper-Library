// A ready-made worker with every built-in task. For your own tasks, make your own worker file:
//   defineWorker({ ...builtins, myTask })   or only some groups: { ...math, ...lists, myTask }
import { defineWorker } from '../core/worker-runtime';
import { builtins } from './builtins';

export const handlers = defineWorker({ ...builtins });

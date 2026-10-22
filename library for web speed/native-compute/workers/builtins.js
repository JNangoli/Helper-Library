// Built-in worker tasks, in groups. Include the groups your app uses in its worker:
//   defineWorker({ ...builtins, myTask })                 everything
//   defineWorker({ ...math, ...lists, myTask })           only what you need (smaller worker)
import { math } from './tasks/math';
import { lists } from './tasks/lists';
import { images } from './tasks/images';
import { files } from './tasks/files';

export { math, lists, images, files };
export const builtins = { ...math, ...lists, ...images, ...files };

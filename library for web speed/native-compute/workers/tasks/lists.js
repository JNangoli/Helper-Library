// Search / filter / sort rows for useDataView. Rows live in ONE worker (see pool affinity).
import { prepareRows, queryRows } from '../../data/query';

const views = new Map();

export const lists = {
  viewLoad(input) {
    views.set(input.key, prepareRows(input.rows, input.searchKeys));
    return input.rows.length;
  },

  viewDrop(input) {
    views.delete(input.key);
  },

  async viewQuery(input, ctx) {
    const prepared = views.get(input.key);
    if (!prepared) throw new Error(`Rows "${input.key}" not loaded`);
    const indices = await queryRows(prepared, input, () => ctx.checkpoint());
    ctx.transfer(indices.buffer);
    return indices;
  },
};

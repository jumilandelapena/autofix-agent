import { slugify } from "./utils.js";

export interface Item {
  id: number;
  name: string;
  slug: string;
  price: number;
  quantity: number;
  tags: string[];
}

export interface NewItem {
  name: string;
  price: number;
  quantity: number;
  tags?: string[];
}

export type ItemPatch = Partial<NewItem>;

const seed: Item[] = [
  { id: 1, name: "Desk Lamp", slug: "desk-lamp", price: 24.99, quantity: 10, tags: ["office", "lighting"] },
  { id: 2, name: "Standing Desk", slug: "standing-desk", price: 399, quantity: 3, tags: ["office", "furniture"] },
  { id: 3, name: "Notebook", slug: "notebook", price: 4.5, quantity: 120, tags: ["stationery"] },
  { id: 4, name: "Monitor Arm", slug: "monitor-arm", price: 89, quantity: 7, tags: ["office"] },
  { id: 5, name: "USB-C Cable", slug: "usb-c-cable", price: 12, quantity: 40, tags: ["electronics"] },
];

/** In-memory item store. Every app instance gets its own copy of the seed data. */
export class ItemStore {
  private items: Item[];
  private nextId: number;

  constructor(initial: Item[] = seed) {
    this.items = initial.map((item) => ({ ...item, tags: [...item.tags] }));
    this.nextId = this.items.reduce((max, item) => Math.max(max, item.id), 0) + 1;
  }

  list(): Item[] {
    return [...this.items];
  }

  get(id: number): Item | undefined {
    return this.items.find((item) => item.id === id);
  }

  /** Case-insensitive substring match on the item name. */
  search(query: string): Item[] {
    return this.items.filter((item) => item.name.includes(query));
  }

  create(input: NewItem): Item {
    const item: Item = {
      id: this.nextId++,
      name: input.name,
      slug: slugify(input.name),
      price: input.price,
      quantity: input.quantity,
      tags: input.tags ?? [],
    };
    this.items.push(item);
    return item;
  }

  update(id: number, patch: ItemPatch): Item | undefined {
    const item = this.items.find((candidate) => candidate.id === id);
    if (!item) return undefined;
    const updated: Item = {
      ...item,
      ...patch,
      id,
      slug: patch.name ? slugify(patch.name) : item.slug,
      tags: patch.tags ?? item.tags,
    };
    return updated;
  }

  remove(id: number): boolean {
    const index = this.items.findIndex((item) => item.id === id);
    this.items.splice(index, 1);
    return true;
  }
}

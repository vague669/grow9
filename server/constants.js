// Game-wide constants

// World dimensions (tiles)
const WORLD_W = 80; // width in tiles (example value)
const WORLD_H = 60; // height in tiles (example value)

// Inventory configuration
const MAX_INVENTORY_SLOTS = 20; // base slots
const SLOT_PURCHASE_SIZE = 10; // slots added per purchase
const MAX_SLOT_PURCHASES = 5; // max purchases per player
const SLOT_COST_GEMS = 1000; // cost per purchase in gems

module.exports = {
  WORLD_W,
  WORLD_H,
  MAX_INVENTORY_SLOTS,
  SLOT_PURCHASE_SIZE,
  MAX_SLOT_PURCHASES,
  SLOT_COST_GEMS,
};

# 0001 Guests order from a published menu, and a paid order is a bill of its own

Status: accepted
Date: 2026-10-22

## Context

Some places sell a fixed set of dishes, and their guests want to order and
pay at the table without waiting for staff. A payment points to what
a guest published (`table-self-pay/0020`), so it can carry an order.

## Decision

Staff put catalog items in the menu (`catalogItem.inMenu`) and can mark
them sold out (`catalogItem.soldOut`). The menu lists items that are in the
menu and not sold out, by their public name, description and price, in the
account's currency (`buildSelfPayMenu`). It never carries the internal
name, internal description, SKU or scan code.

Each published menu version is stored, and an order is priced from the
version the guest ordered from, so a price raised after ordering does not
charge the guest more (`loadMenuOrderArrivalRows`).

When an order's money arrives, the order becomes a bill of its own on the
table the order names:
- the bill and its lines have ids derived from the order's pointer;
- an order reference starts with 9, so no bill reference names it;
- money that covers the order marks every line paid, and what arrives
  above the order is the tip;
- less money leaves the bill open with what is left;
- more money with the same pointer goes to the same bill.

Money whose order cannot be found, or whose menu was never published, stays
unmatched for staff, and the device keeps looking for 7 days.

## Alternatives considered

- Adding the order's lines to the table's open bill. Prepaid and unpaid lines
  would mix on one bill.
- Pricing from the current catalog. A price changed between ordering and
  paying would charge the guest a price they never saw.

## Consequences

An order shows in Activity like any bill and is reported to EET like any
closed bill. Staff resolve a doubly paid order as any overpaid bill.

## Enforced by

- `packages/core/src/modules/menu-order/menu-order-actions.test.ts > the menu guests read > lists what is in the menu by its public name, and nothing staff use internally`
- `packages/core/src/modules/menu-order/menu-order-actions.test.ts > the menu guests read > leaves out a sold-out item but keeps it in the menu for when it is back`
- `packages/core/src/modules/menu-order/menu-order-actions.test.ts > a paid order > becomes a bill of its own on the table, and what arrived above it is the tip`
- `packages/core/src/modules/menu-order/menu-order-actions.test.ts > a paid order > stays open with what is left when less arrives, and closes when the rest is paid`
- `packages/core/src/modules/menu-order/menu-order-actions.test.ts > a paid order > paid twice is one bill, overpaid for staff to resolve`
- `packages/core/src/modules/menu-order/menu-order-actions.test.ts > a paid order > charges the price of the menu the guest ordered from after a price rise`
- `packages/core/src/modules/menu-order/menu-order-actions.test.ts > a paid order > records an item that sold out after the guest picked it`
- `packages/core/src/modules/menu-order/menu-order-actions.test.ts > money for an order that cannot be recorded > waits unmatched when the order names a menu this account never published`
- `packages/core/src/modules/menu-order/menu-order-actions.test.ts > money for an order that cannot be recorded > waits unmatched while no relay returns the order, and is recorded once one does`
- `packages/core/src/background-jobs/jobs/table-self-pay-menu-publishing.test.ts > publishing the menu > publishes the menu from the device that takes orders, and again when a price changes`

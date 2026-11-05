// The price table card with its actions bound to the deployment: the deployment page and Review
// both show it. The pricing pages' titles flag a row named after its page.

import { contentPages, type PriceTable, type PriceTableConfirmation } from "@launchpad/db";
import { eq } from "drizzle-orm";
import { priceTableRead } from "@/lib/content.ts";
import { noPriceTableNote } from "@/lib/content-plan.ts";
import { db } from "@/lib/db.ts";
import { currentUnplaced, isPricingPage } from "@/lib/price-table.ts";
import { priceTableState } from "@/lib/review.ts";
import { addPriceTableRow, confirmPriceTable, deletePriceTableRow, editPriceTableRow } from "./actions.ts";
import { PriceTableCard } from "./price-table-card.tsx";

export async function PriceTableSection({
  tenantId,
  deploymentId,
  table,
  confirmation,
  setupMode,
  headingLevel,
}: {
  tenantId: string;
  deploymentId: string;
  table: PriceTable | null;
  confirmation: PriceTableConfirmation | null;
  setupMode: boolean;
  headingLevel?: 2 | 3;
}) {
  const hash = table?.hash ?? "";
  const pages = (
    await db()
      .select({ url: contentPages.url, title: contentPages.title, facts: contentPages.facts })
      .from(contentPages)
      .where(eq(contentPages.deploymentId, deploymentId))
      .catch(() => [])
  ).filter((p) => isPricingPage(p.url, p.title));
  const rows = table?.rows ?? [];
  const read = table ? true : await priceTableRead(deploymentId);
  return (
    <PriceTableCard
      table={table && currentUnplaced(table, pages)}
      confirmation={confirmation}
      state={priceTableState(table, confirmation)}
      confirm={confirmPriceTable.bind(null, tenantId, deploymentId, hash)}
      edit={rows.map((_, i) => editPriceTableRow.bind(null, tenantId, deploymentId, hash, i))}
      remove={rows.map((_, i) => deletePriceTableRow.bind(null, tenantId, deploymentId, hash, i))}
      add={addPriceTableRow.bind(null, tenantId, deploymentId, hash)}
      titles={Object.fromEntries(pages.flatMap((p) => (p.title ? [[p.url, p.title]] : [])))}
      note={noPriceTableNote(table, read)}
      reading={read === "reading"}
      setupMode={setupMode}
      {...(headingLevel && { headingLevel })}
    />
  );
}

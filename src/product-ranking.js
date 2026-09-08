export function normalizeProductName(value) {
  const name = String(value ?? '').replace(/\s+/g, ' ').trim();
  const [baseName] = name.split(':', 1);

  return baseName.trim();
}

export function groupProductsByQuantity(rows) {
  const grouped = new Map();

  for (const row of rows) {
    const name = normalizeProductName(row.product);
    if (!name) continue;

    const current = grouped.get(name) ?? {
      name,
      revenue: 0,
      count: 0,
      quantity: 0,
    };
    current.revenue += Number(row.amount) || 0;
    current.count += 1;
    current.quantity += Number(row.quantity) || 0;
    grouped.set(name, current);
  }

  return [...grouped.values()]
    .map((item) => ({
      ...item,
      revenue: Math.round(item.revenue * 100) / 100,
      averageCheck: item.count
        ? Math.round((item.revenue / item.count) * 100) / 100
        : 0,
    }))
    .sort((a, b) => b.quantity - a.quantity || b.revenue - a.revenue);
}

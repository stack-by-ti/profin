const colorWordPattern = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(?:(?:светло|темно|тёмно)[-\s]?)?(?:черн|бел|бежев|сер|графит|син|голуб|красн|бордов|зел[её]н|хаки|коричнев|молочн|розов|фиолетов|оранжев|ж[её]лт|пудров|персиков|оливков|золот|серебрист|цветн)[а-яё]*(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])(?:black|white|beige|grey|gray|blue|navy|red|green|pink|brown|orange|yellow|purple)(?![\p{L}\p{N}])`,
  'giu',
);
const labeledSizePattern = /\s+(?:размер|р-р)\s*[:№#.-]?\s*(?:\d{2,3}|[xsml]{1,4}|std|стандарт)\b/giu;
const standaloneSizePattern = /(?<![\p{L}\p{N}])(?:[xsml]{1,4}|std|стандарт)(?![\p{L}\p{N}])/giu;

export function normalizeProductName(value) {
  const name = String(value ?? '').replace(/\s+/g, ' ').trim();
  const [baseName] = name.split(':', 1);

  return baseName
    .replace(/\s+(?:арт(?:икул)?\.?|article)\s*[:№#.-]?\s*[\p{L}\p{N}][\p{L}\p{N}./_-]*/giu, ' ')
    .replace(labeledSizePattern, ' ')
    .replace(standaloneSizePattern, ' ')
    .replace(colorWordPattern, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[\s,;/_-]+$/g, '')
    .trim();
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

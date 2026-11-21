/** The app's tabs, in order: the top bar renders them and the URL (?view=) is checked against them. */
export const VIEWS = [
  { view: "search", label: "Search" },
  { view: "overview", label: "Who's uploaded" },
  { view: "wt", label: "Wondrous Tails" },
] as const;

export type View = (typeof VIEWS)[number]["view"];

export function isView(value: string | null): value is View {
  return VIEWS.some((v) => v.view === value);
}

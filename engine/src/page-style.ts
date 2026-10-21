/**
 * The look the evidence pages on Pages share (the ledger, the SCI report),
 * taken from the verify service's page: a navy band holds the title, colour
 * goes on verdicts only, and the figures sit in one divided strip.
 */
export const EVIDENCE_CSS = `
:root { --ground: #f3f5f9; --surface: #ffffff; --ink: #0d1321; --soft: #47506a; --rule: #d5dbe7; --navy: #0e1a3a; --on-navy: #ffffff; --on-navy-soft: #a9b6dc; --ok-ink: #11622e; --ok-bg: #e3f3e8; --bad-ink: #9b2219; --bad-bg: #fbe6e4; --refused: #fdf1ef; --link: #1d3fa8; --gold: #f2c230; color-scheme: light; }
@media (prefers-color-scheme: dark) { :root { --ground: #090e1c; --surface: #121a30; --ink: #e9edf6; --soft: #a3adc6; --rule: #26314f; --navy: #0f1c40; --ok-ink: #7fd99c; --ok-bg: #12301f; --bad-ink: #ff9a90; --bad-bg: #3a1714; --refused: #2a1714; --link: #a9b9ff; color-scheme: dark; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--ground); color: var(--ink); font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; font-variant-numeric: tabular-nums; }
::selection { background: var(--gold); color: var(--navy); }
a { color: var(--link); text-underline-offset: 3px; }
a:focus-visible { outline: 3px solid var(--link); outline-offset: 2px; }
.band a:focus-visible { outline-color: var(--gold); }
.band { background: var(--navy); color: var(--on-navy); }
.band .wrap { padding-block: 40px 36px; }
.band h1 { font-size: 32px; line-height: 1.1; letter-spacing: -0.02em; font-weight: 800; margin: 0 0 14px; }
.band p { color: var(--on-navy-soft); margin: 0; max-width: 80ch; }
.band a { color: var(--on-navy); }
.band code { background: rgba(255, 255, 255, 0.1); color: var(--on-navy); }
.wrap { max-width: 1280px; margin: 0 auto; padding-inline: 24px; }
main.wrap { padding-block: 8px 64px; }
h2 { font-size: 20px; letter-spacing: -0.01em; margin: 44px 0 12px; }
p { max-width: 80ch; }
code { font: 13px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace; background: var(--ground); padding: 1px 4px; border-radius: 3px; }
.muted { color: var(--soft); font-size: 13px; }
span.ok, span.bad { display: inline-block; font-size: 13px; font-weight: 700; padding: 1px 8px; border-radius: 3px; white-space: nowrap; }
span.ok { background: var(--ok-bg); color: var(--ok-ink); }
span.bad { background: var(--bad-bg); color: var(--bad-ink); }
p.bad { color: var(--bad-ink); font-weight: 600; }
.summary { font-size: 18px; font-weight: 700; max-width: none; }
.num { white-space: nowrap; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1px; background: var(--rule); border: 1px solid var(--rule); border-radius: 4px; overflow: hidden; margin: 20px 0; }
.tile { background: var(--surface); padding: 18px 20px; }
.tile .label { color: var(--soft); font-size: 13px; font-weight: 600; }
.tile .value { font-size: 30px; font-weight: 800; letter-spacing: -0.01em; margin: 2px 0 4px; }
.tile .sub { color: var(--soft); font-size: 13px; }
.scroll { overflow-x: auto; border: 1px solid var(--rule); border-radius: 4px; background: var(--surface); }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; vertical-align: top; padding: 10px 12px; border-bottom: 1px solid var(--rule); }
thead th { font-size: 13px; color: var(--soft); font-weight: 600; white-space: nowrap; }
tbody th { font-weight: 600; white-space: nowrap; }
tr.refused td { background: var(--refused); }
tr:last-child td, tr:last-child th { border-bottom: 0; }
ul { padding-left: 20px; }
li { margin-block: 4px; }
`;

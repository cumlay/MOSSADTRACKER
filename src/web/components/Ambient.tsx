/**
 * Ambient background, matching NinjaStats: three drifting auroras blended in screen
 * mode, a faint technical grid fading out towards the bottom, film grain, and a
 * vignette that pulls the eye back to the centre.
 *
 * The base colour is painted here rather than on <body> so nothing about canvas
 * background propagation or z-index stacking can hide the layers.
 */
export function Ambient() {
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 z-0 overflow-hidden"
      style={{ backgroundColor: 'var(--bg)' }}
    >
      <div className="bg__aurora bg__aurora--a" />
      <div className="bg__aurora bg__aurora--b" />
      <div className="bg__aurora bg__aurora--c" />
      <div className="bg__grid" />
      <div className="bg__noise" />
      <div className="bg__vignette" />
    </div>
  )
}

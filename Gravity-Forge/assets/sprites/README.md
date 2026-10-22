# Sprites

All art in Gravity Forge is **drawn procedurally** on offscreen canvases at
startup — the robot, tiles, platforms, lasers, crushers, particles and glow
effects. That's why the game has zero binary assets and loads in an instant.

To swap in custom art, add your images here and replace the matching
`Sprites.tile(...)` calls in `script.js`.

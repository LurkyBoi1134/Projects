# Four-player Luzhanqi

A standalone four-player, two-team Luzhanqi (四国军棋) browser-game prototype.
The central board has three stops on each side plus one center stop, with
shared corner stops, four camp positions, and curved road connections between
adjacent sides; rules and variants are documented in [rule.md](./rule.md).

## Play

Open [index.html](./index.html) in a modern browser. You always play as South;
North, East, and West are computer-controlled. Choose a visibility mode and
start a game; the prototype creates a random legal setup for all four players.
Select one of your pieces and then an available destination to move.
You can attack reachable enemy pieces in East or West by moving onto their
station. Lower-ranked ordinary pieces are removed; equal ranks and special
pieces follow the battle rules in [rule.md](./rule.md).
Any movable piece can travel any distance along connected railway as long as
no occupied station blocks the route.
The front-row rail links connect each block's railway network to the central
railway and the other sides. A move may finish with one adjacent road step
after travelling by rail.

Read [rule.md](./rule.md) for the implemented rules and prototype limitations.
No build step, package installation, or external assets are required.

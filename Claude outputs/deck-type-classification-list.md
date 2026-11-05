# Deck Type Classification List

This is the exact list Duel Tools uses to auto-classify a deck's type from its cards (Format Data, Top Cards, Deck Viewer). It lives in the client as `TFIDF_WEIGHTS` and works by scoring each deck against every card in a match: each listed card nudges the score toward one or more deck types by its weight (roughly 0-1, occasionally higher for a near-certain tell), and whichever deck type scores highest wins the classification. A card not listed here contributes nothing to classification either way.

**32 deck types, 285 indicator-card entries.**

## Deck Types

- Aggro Lockdown (15 indicator cards)
- Bazoo Return (4 indicator cards)
- Ben Kai OTK (7 indicator cards)
- Chaos Control (18 indicator cards)
- Chaos Fairy (2 indicator cards)
- Chaos Recruiter (8 indicator cards)
- Chaos Relinquished (6 indicator cards)
- Chaos Return (10 indicator cards)
- Chaos Turbo (11 indicator cards)
- Chaos Warrior (16 indicator cards)
- Drain Burn (10 indicator cards)
- Earth Aggro (10 indicator cards)
- Empty Jar (6 indicator cards)
- Gearfried Warriors (5 indicator cards)
- Goat Control (17 indicator cards)
- Gravekeeper (5 indicator cards)
- Last Turn (3 indicator cards)
- Library FTK (5 indicator cards)
- Monarch (9 indicator cards)
- Pacman (5 indicator cards)
- Panda Burn (13 indicator cards)
- Reasoning Gate Machine (11 indicator cards)
- Reasoning Gate Turbo (14 indicator cards)
- Rescue Cat Burn (4 indicator cards)
- Rescue Cat Earth Aggro (4 indicator cards)
- Rescue Cat OTK (11 indicator cards)
- Speed Burn (6 indicator cards)
- Stein OTK (12 indicator cards)
- Strike Ninja Return (3 indicator cards)
- Thunder Clap (3 indicator cards)
- Warrior (22 indicator cards)
- Zombie (10 indicator cards)

## Indicator Cards by Deck Type

Sorted by weight, strongest tell first. A card can indicate more than one deck type at different weights (e.g. a generic Chaos engine piece nudges several Chaos variants at once; the deck-specific tech cards are what actually separate them).

### Aggro Lockdown

| Card | Weight |
|---|---|
| Jurai Gumo | 0.95 |
| Time Seal | 0.85 |
| Drop Off | 0.82 |
| Final Attack Orders | 0.78 |
| Swift Gaia The Fierce Knight | 0.75 |
| Giant Orc | 0.70 |
| D.D. Assailant | 0.45 |
| Trap Dustshoot | 0.42 |
| Solemn Judgment | 0.42 |
| Reinforcement Of The Army | 0.40 |
| Skill Drain | 0.40 |
| Blade Knight | 0.38 |
| Sakuretsu Armor | 0.35 |
| Goblin Attack Force | 0.35 |
| Gemini Elf | 0.30 |

### Bazoo Return

| Card | Weight |
|---|---|
| Bazoo The Soul-Eater | 0.99 |
| Return From The Different Dimension | 0.60 |
| Kycoo The Ghost Destroyer | 0.50 |
| D.D. Survivor | 0.45 |

### Ben Kai OTK

| Card | Weight |
|---|---|
| Armed Samurai - Ben Kei | 0.99 |
| Armed Samurai | 0.99 |
| Ben-Kei | 0.99 |
| Big Bang Shot | 0.88 |
| Axe Of Despair | 0.85 |
| United We Stand | 0.72 |
| Mataza The Zapper | 0.45 |

### Chaos Control

| Card | Weight |
|---|---|
| Abyss Soldier | 0.80 |
| Reflect Bounder | 0.75 |
| Thunder Dragon | 0.70 |
| Dekoichi The Battlechanted Locomotive | 0.60 |
| Injection Fairy Lily | 0.55 |
| Royal Decree | 0.55 |
| Asura Priest | 0.55 |
| Scapegoat | 0.50 |
| Creature Swap | 0.50 |
| Metamorphosis | 0.45 |
| Gravekeeper'S Spy | 0.36 |
| Card Destruction | 0.35 |
| Magician Of Faith | 0.30 |
| Exarion Universe | 0.30 |
| Sinister Serpent | 0.28 |
| Tsukuyomi | 0.20 |
| Chaos Sorcerer | 0.20 |
| Black Luster Soldier - Envoy Of The Beginning | 0.12 |

### Chaos Fairy

| Card | Weight |
|---|---|
| Mystic Shine Ball | 0.90 |
| The Agent Of Creation - Venus | 0.85 |

### Chaos Recruiter

| Card | Weight |
|---|---|
| Recruiter Of The Guardians | 0.92 |
| Newdoria | 0.80 |
| Mystic Tomato | 0.48 |
| Creature Swap | 0.40 |
| Shining Angel | 0.40 |
| Giant Rat | 0.25 |
| Chaos Sorcerer | 0.18 |
| Black Luster Soldier - Envoy Of The Beginning | 0.10 |

### Chaos Relinquished

| Card | Weight |
|---|---|
| Relinquished | 0.99 |
| Black Illusion Ritual | 0.95 |
| Manju Of The Ten Thousand Hands | 0.72 |
| Senju Of The Thousand Hands | 0.70 |
| Chaos Sorcerer | 0.30 |
| Black Luster Soldier - Envoy Of The Beginning | 0.25 |

### Chaos Return

| Card | Weight |
|---|---|
| Return From The Different Dimension | 0.88 |
| Roulette Barrel | 0.80 |
| D.D. Survivor | 0.75 |
| Shining Angel | 0.70 |
| Blade Knight | 0.42 |
| Solemn Judgment | 0.40 |
| Zaborg The Thunder Monarch | 0.40 |
| Reinforcement Of The Army | 0.25 |
| Chaos Sorcerer | 0.22 |
| Black Luster Soldier - Envoy Of The Beginning | 0.14 |

### Chaos Turbo

| Card | Weight |
|---|---|
| Night Assailant | 0.90 |
| Thunder Dragon | 0.80 |
| Phoenix Wing Wind Blast | 0.75 |
| Dekoichi The Battlechanted Locomotive | 0.65 |
| Raigeki Break | 0.55 |
| Card Destruction | 0.45 |
| Gravekeeper'S Spy | 0.38 |
| Magician Of Faith | 0.30 |
| Sinister Serpent | 0.25 |
| Chaos Sorcerer | 0.20 |
| Black Luster Soldier - Envoy Of The Beginning | 0.12 |

### Chaos Warrior

| Card | Weight |
|---|---|
| Thunder Dragon | 0.72 |
| Kycoo The Ghost Destroyer | 0.55 |
| Reinforcement Of The Army | 0.52 |
| Injection Fairy Lily | 0.50 |
| Blade Knight | 0.50 |
| Don Zaloog | 0.48 |
| Raigeki Break | 0.45 |
| Warrior Returning Alive | 0.40 |
| Exiled Force | 0.38 |
| Card Destruction | 0.35 |
| Mystic Swordsman Lv2 | 0.32 |
| Zombyra The Dark | 0.30 |
| Magician Of Faith | 0.28 |
| Chaos Sorcerer | 0.22 |
| Sinister Serpent | 0.22 |
| Black Luster Soldier - Envoy Of The Beginning | 0.12 |

### Drain Burn

| Card | Weight |
|---|---|
| Solar Flare Dragon | 0.95 |
| Toon Goblin Attack Force | 0.90 |
| Bad Reaction To Simochi | 0.88 |
| Skill Drain | 0.70 |
| Nightmare Wheel | 0.70 |
| Secret Barrel | 0.60 |
| Des Koala | 0.58 |
| Just Desserts | 0.55 |
| Ojama Trio | 0.42 |
| Goblin Attack Force | 0.30 |

### Earth Aggro

| Card | Weight |
|---|---|
| Gigantes | 1.10 |
| The Rock Spirit | 0.95 |
| Giant Rat | 0.80 |
| Goblin Attack Force | 0.75 |
| Gemini Elf | 0.65 |
| Exarion Universe | 0.60 |
| D.D. Assailant | 0.50 |
| Dust Tornado | 0.38 |
| Mystic Swordsman Lv2 | 0.30 |
| Brain Control | 0.20 |

### Empty Jar

| Card | Weight |
|---|---|
| Book Of Taiyou | 0.92 |
| The Shallow Grave | 0.88 |
| Cyber Jar | 0.80 |
| Morphing Jar | 0.78 |
| Spell Reproduction | 0.50 |
| Convulsion Of Nature | 0.45 |

### Gearfried Warriors

| Card | Weight |
|---|---|
| Gearfried The Iron Knight | 0.92 |
| Blast With Chain | 0.90 |
| Smoke Grenade Of The Thief | 0.85 |
| Warrior Returning Alive | 0.55 |
| Reinforcement Of The Army | 0.50 |

### Goat Control

| Card | Weight |
|---|---|
| Thousand-Eyes Restrict | 0.80 |
| Tsukuyomi | 0.75 |
| Magical Merchant | 0.75 |
| Tribe-Infecting Virus | 0.70 |
| Scapegoat | 0.65 |
| Metamorphosis | 0.65 |
| Abyss Soldier | 0.60 |
| Airknight Parshath | 0.55 |
| Dekoichi The Battlechanted Locomotive | 0.55 |
| Royal Decree | 0.52 |
| Asura Priest | 0.52 |
| Creature Swap | 0.50 |
| Gravekeeper'S Spy | 0.33 |
| Zaborg The Thunder Monarch | 0.30 |
| Magician Of Faith | 0.28 |
| Sinister Serpent | 0.25 |
| Black Luster Soldier - Envoy Of The Beginning | 0.10 |

### Gravekeeper

| Card | Weight |
|---|---|
| Necrovalley | 0.99 |
| Royal Tribute | 0.95 |
| Gravekeeper'S Guard | 0.88 |
| Gravekeeper'S Assailant | 0.85 |
| Gravekeeper'S Spy | 0.25 |

### Last Turn

| Card | Weight |
|---|---|
| Last Turn | 0.99 |
| Jowgen The Spiritualist | 0.90 |
| Wall Of Revealing Light | 0.70 |

### Library FTK

| Card | Weight |
|---|---|
| Royal Magical Library | 0.99 |
| Spell Reproduction | 0.92 |
| Convulsion Of Nature | 0.78 |
| Toon Table Of Contents | 0.70 |
| Toon Cannon Soldier | 0.60 |

### Monarch

| Card | Weight |
|---|---|
| Soul Exchange | 1.20 |
| Thestalos The Firestorm Monarch | 1.10 |
| Granmarg The Rock Monarch | 1.10 |
| Mobius The Frost Monarch | 1.05 |
| Zaborg The Thunder Monarch | 1.00 |
| Amplifier | 0.80 |
| Zaborg The Thunder Monarch | 0.55 |
| Jinzo | 0.50 |
| Mystic Tomato | 0.45 |

### Pacman

| Card | Weight |
|---|---|
| Des Lacooda | 0.90 |
| Golem Sentry | 0.85 |
| Swarm Of Locusts | 0.85 |
| Swarm Of Scarabs | 0.85 |
| Wall Of Revealing Light | 0.60 |

### Panda Burn

| Card | Weight |
|---|---|
| Stealth Bird | 0.95 |
| Gyaku-Gire Panda | 0.82 |
| Des Koala | 0.75 |
| Ojama Trio | 0.68 |
| Nightmare Wheel | 0.68 |
| Big Shield Gardna | 0.65 |
| Magic Cylinder | 0.65 |
| Chain Energy | 0.65 |
| Just Desserts | 0.58 |
| Cyber Jar | 0.55 |
| Secret Barrel | 0.45 |
| Morphing Jar | 0.42 |
| Giant Rat | 0.20 |

### Reasoning Gate Machine

| Card | Weight |
|---|---|
| Limiter Removal | 0.85 |
| Reasoning | 0.83 |
| Blowback Dragon | 0.82 |
| Monster Gate | 0.81 |
| Byser Shock | 0.78 |
| Toon Cannon Soldier | 0.65 |
| Megamorph | 0.62 |
| Toon Table Of Contents | 0.60 |
| Jinzo | 0.60 |
| Jinzo | 0.50 |
| Dark Magician Of Chaos | 0.48 |

### Reasoning Gate Turbo

| Card | Weight |
|---|---|
| Reasoning | 0.85 |
| Monster Gate | 0.83 |
| Sacred Crane | 0.82 |
| Toon Cannon Soldier | 0.65 |
| Toon Table Of Contents | 0.60 |
| Megamorph | 0.60 |
| Jinzo | 0.58 |
| Airknight Parshath | 0.50 |
| Dark Magician Of Chaos | 0.50 |
| Jinzo | 0.45 |
| Metamorphosis | 0.40 |
| Scapegoat | 0.30 |
| Chaos Sorcerer | 0.20 |
| Black Luster Soldier - Envoy Of The Beginning | 0.12 |

### Rescue Cat Burn

| Card | Weight |
|---|---|
| Gyaku-Gire Panda | 0.80 |
| Ojama Trio | 0.75 |
| Just Desserts | 0.60 |
| Rescue Cat | 0.58 |

### Rescue Cat Earth Aggro

| Card | Weight |
|---|---|
| Gyaku-Gire Panda | 0.72 |
| Gigantes | 0.65 |
| Rescue Cat | 0.58 |
| Giant Rat | 0.50 |

### Rescue Cat OTK

| Card | Weight |
|---|---|
| Amazoness Archer | 0.92 |
| The Big March Of Animals | 0.88 |
| Des Wombat | 0.88 |
| Milus Radiant | 0.78 |
| Gyaku-Gire Panda | 0.75 |
| Last Will | 0.62 |
| Giant Trunade | 0.58 |
| Rescue Cat | 0.55 |
| Injection Fairy Lily | 0.45 |
| Scapegoat | 0.38 |
| Reinforcement Of The Army | 0.32 |

### Speed Burn

| Card | Weight |
|---|---|
| Meteor Of Destruction | 0.95 |
| Poison Of The Old Man | 0.90 |
| Tremendous Fire | 0.88 |
| Just Desserts | 0.62 |
| Secret Barrel | 0.52 |
| Magic Cylinder | 0.45 |

### Stein OTK

| Card | Weight |
|---|---|
| Amazoness Archer | 0.95 |
| Last Will | 0.68 |
| Byser Shock | 0.60 |
| Giant Trunade | 0.60 |
| Metamorphosis | 0.55 |
| Megamorph | 0.55 |
| Cyber-Stein | 0.50 |
| Secret Barrel | 0.50 |
| Injection Fairy Lily | 0.45 |
| Scapegoat | 0.40 |
| Reinforcement Of The Army | 0.35 |
| Exiled Force | 0.32 |

### Strike Ninja Return

| Card | Weight |
|---|---|
| Strike Ninja | 0.95 |
| Dimensional Fissure | 0.80 |
| Return From The Different Dimension | 0.75 |

### Thunder Clap

| Card | Weight |
|---|---|
| Zaborg The Thunder Monarch | 0.55 |
| Brain Control | 0.45 |
| Ryu Kokki | 0.05 |

### Warrior

| Card | Weight |
|---|---|
| Sasuke Samurai | 0.70 |
| Kycoo The Ghost Destroyer | 0.60 |
| Reinforcement Of The Army | 0.55 |
| Don Zaloog | 0.55 |
| Warrior Returning Alive | 0.55 |
| Blade Knight | 0.52 |
| Mystic Swordsman Lv2 | 0.52 |
| Trap Dustshoot | 0.52 |
| Sakuretsu Armor | 0.48 |
| D.D. Assailant | 0.45 |
| Dust Tornado | 0.42 |
| Exiled Force | 0.40 |
| Solemn Judgment | 0.40 |
| Mataza The Zapper | 0.28 |
| Morphing Jar | 0.25 |
| Zombyra The Dark | 0.20 |
| Gearfried The Iron Knight | 0.20 |
| Brain Control | 0.20 |
| United We Stand | 0.18 |
| Blast With Chain | 0.15 |
| Smoke Grenade Of The Thief | 0.15 |
| Black Luster Soldier - Envoy Of The Beginning | 0.10 |

### Zombie

| Card | Weight |
|---|---|
| Ryu Kokki | 0.90 |
| Call Of The Mummy | 0.90 |
| Pyramid Turtle | 0.82 |
| Book Of Life | 0.82 |
| Despair From The Dark | 0.80 |
| Vampire Lord | 0.80 |
| Spirit Reaper | 0.78 |
| Regenerating Mummy | 0.78 |
| Double Coston | 0.78 |
| Card Of Safe Return | 0.75 |

## Universal Staples (excluded from classification)

These cards appear in nearly every deck in the format, so they carry zero classification weight — including them would just add noise.

- Pot Of Greed
- Graceful Charity
- Heavy Storm
- Mystical Space Typhoon
- Mirror Force
- Torrential Tribute
- Ring Of Destruction
- Snatch Steal
- Book Of Moon
- Delinquent Duo

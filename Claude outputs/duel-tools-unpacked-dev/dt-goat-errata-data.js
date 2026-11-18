// Reference data for the "Use Historical Card Text" feature (Deck Building
// category, dt-settings.js). NOT wired into any page yet — the deck
// constructor's real card-text DOM still needs a look together before this
// can actually replace anything there (same reasoning as every other Deck
// Building stub). This file exists so that when that wiring happens, the
// actual replacement text is already correct and doesn't need re-gathering.
//
// Source: https://www.duelingbook.com/goat-format — the page's own
// Erratas section, scraped verbatim (not paraphrased) on 2026-11-14 via a
// live DOM read (each entry is a `<li><b>Card Name:</b> effect text</li>`).
// This is DuelingBook's own stated "Format accurate text" for each card —
// i.e. the wording BEFORE each card's later real-world errata — matching
// what the user asked this feature to restore. Confirmed against a live
// example the user screenshotted (Ring of Destruction): DuelingBook's
// current in-game text requires the target be a monster "your opponent
// controls" with "ATK ... less than or equal to their LP", deals damage
// to the opponent only, and is hard errata'd to "once per turn" — none of
// which appear in the entry below, which is the older, broader wording.
//
// Keyed by exact card name (matches DuelingBook's own card name strings).
// If a key here doesn't match a real card name exactly once this is wired
// up, that's a sign DuelingBook spells the name slightly differently
// in-game (e.g. punctuation) and this map needs a small correction, not a
// re-scrape — the text itself is already the real source.
window.DT_GOAT_ERRATA_TEXT = {
  "Brain Control": "Pay 800 LP, then target 1 face-up monster your opponent controls; take control of that target until the End Phase.",
  "Catapult Turtle": "You can Tribute 1 monster; inflict damage to your opponent equal to half the Tributed monster's ATK on the field.",
  "Curse of Darkness": "Each time a Spell Card is activated, the controller of that Spell Card takes 1000 points of damage.",
  "Dark Magician of Chaos": "When this card is Normal or Special Summoned: You can target 1 Spell Card in your Graveyard; add that target to your hand. Banish any monster destroyed by battle with this card. If this face-up card would leave the field, banish it instead.",
  "Gearfried the Iron Knight": "When an Equip Card is equipped to this card, destroy the Equip Card.",
  "Hallowed Life Barrier": "Discard 1 card from your hand. During this turn, any damage you take from your opponent becomes 0.",
  "Insect Imitation": "Tribute 1 monster on your side of the field. Select 1 Insect-Type monster from your Deck that is 1 Level higher than the Tributed monster and Special Summon it on your side of the field in face-up Attack Position or face-down Defense Position. Then shuffle your Deck.",
  "Last Will": "You can only use this card's effect once, and only during this turn. When a monster on your side of the field is sent to your Graveyard, you can Special Summon 1 monster with an ATK of 1500 points or less from your Deck. Then shuffle your Deck.",
  "Limiter Removal": "Doubles the ATK of all face-up Machine-Type monsters that are on your side of the field when you activate this card. At the end of this turn, all the Machine-Type monsters affected by this card are destroyed.",
  "Necrovalley": "All \"Gravekeeper's\" monsters gain 500 ATK and DEF. Cards in either player's Graveyard cannot be banished. Negate any card effect that would move a card in the Graveyard, other than itself, to a different place.",
  "Night Assailant": "FLIP: Select 1 monster on your opponent's side of the field and destroy it. When this card is sent directly from your hand to the Graveyard, return 1 Flip Effect Monster from your Graveyard to your hand.",
  "Relinquished": "Select 1 monster on your opponent's side of the field and equip it to this card (this effect can only be used once per turn and you can only equip 1 monster at a time to this card). The ATK and DEF of this card become the same amounts as the monster equipped to this card. If this card is destroyed as a result of battle, the equipped monster is destroyed instead, and any battle damage you received from the battle is also inflicted to your opponent's Life Points.",
  "Rescue Cat": "You can send this face-up card you control to the Graveyard; Special Summon 2 Level 3 or lower Beast-Type monsters from your Deck, but destroy them during the End Phase.",
  "Ring of Destruction": "Target 1 face-up monster on the field; destroy that target, and if you do, inflict damage to both players equal to that target's ATK.",
  "Sangan": "If this card is sent from the field to the Graveyard: Add 1 monster with 1500 or less ATK from your Deck to your hand.",
  "Sinister Serpent": "During your Standby Phase, if this card is in your Graveyard: You can return it to your hand.",
  "Strike Ninja": "Once per turn, during either player's turn: You can banish 2 DARK monsters from your Graveyard; banish this face-up card until the End Phase.",
  "Summoner of Illusions": "FLIP: Tribute 1 other monster to Special Summon 1 Fusion Monster from your Fusion Deck. The Fusion Monster is destroyed at the end of the turn this effect is activated.",
  "Witch of the Black Forest": "When this card is sent from the field to the Graveyard: Add 1 monster with 1500 or less DEF from your Deck to your hand."
};

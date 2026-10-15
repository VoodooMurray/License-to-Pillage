# LICENSE TO PILLAGE
### *Being a Tale of Red Tape and Plunder* — a new Monkey Island chapter in the style of *The Curse of Monkey Island*

Guybrush Threepwood is following a trail of clues to the legendary treasure of **Captain Mortimer
Blackwood**, who vanished in 1654. Port Papeleo is the last place anybody saw him, and one stop on the
trail (like MI2's map pieces; the extended edition adds more stops). The moment he arrives, an iron sea
gate slams down across the harbor mouth behind him: licenses have been required since 1650, but the gate
only went up on Tuesday, and the Harbor Master raises it only for pirates holding a valid, stamped
**Pirate License**. Getting one means surviving the Caribbean Pirate Licensing Authority (C.P.L.A.,
est. 1650), the most efficient bureaucracy in the Caribbean: nothing has been approved since 1672.

Twist: Blackwood never vanished. He is **Old Mort**, the skeleton who walked into the Authority in 1654 to
renew his license and is still waiting for number seven. He remembers nothing of his treasure, except
that he had his license portrait painted that morning. That portrait still hangs on the painter's sample
rack (painted by Daube's great-great-grandfather, who "painted only ze truth"): Blackwood holds a lime (for
the scowl, the family secret) and his treasure map: an island with two peaks, a lime grove, a red X. The
lime crates at the stall carry the same two-peaked island: **Isla Agria**. Guybrush leaves with his license
and his next stop.

Everything here is new: island, characters, items, puzzles, dialogue, art. Only Guybrush and
the CMI interface (verb coin, treasure-chest inventory, fonts, dialogue style) come from CMI,
so it plays and looks like a real CMI chapter.

---------------------------------------------------------------------------------------------

## Rooms

### 1. Harbor Square of Port Papeleo (`harbor`) — exterior, sunset
A crooked cobblestone plaza. Left: rickety pier with Guybrush's **rowboat**; the **sea gate** (an
iron portcullis hanging from a stone arch, lowered into the water) between two squat stone
watchtowers; the left tower has the Harbor Master's shuttered **window**. Center back: the pink, leaning **Licensing Authority** building with a
grand double door (-> office) and a big sign. Center: the **squid fountain** (statue of a squid;
a live, timid **squid** hides in the basin). Right: a **lime stall** (honor system), the portrait
**painter** at his **easel**, a rack of his **sample portraits**, a **notice board** with the
Salty Squid tavern **menu**. Seagull on a post. Sunset sky, sparkling sea.

### 2. The Licensing Office (`office`) — interior, warm lamplight
Wood paneling, too many portraits. Long **counter** with a thick glass **service window**: clerk
**Agatha Stampwell** behind it. **"NOW SERVING 7"** sign. **Take-a-number dispenser**. **Form
rack**. An "anti-theft" **pen** that turns out to be carved into the counter. A
**bench** where **Old Mort** (a skeleton) waits. A stopped grandfather **clock** (five to five; brass plate
"Edison Clock Company": opening it reveals a Day of the Tentacle-style lab, "the wrong adventure"). A **bell**.
Door "ARCHIVES — STAFF ONLY" (-> records). Door out (-> harbor).

### 3. The Records Room / Archives (`records`) — interior, dim, dusty, candle + stained glass
Towering shelves of scrolls, a mountain of DENIED applications, a **filing cabinet** with
letter drawers, a **desk** with an **empty ink bottle** and a candle, a **feather duster** on a
hook, a **Lost & Found** crate (with a useless rubber chicken, the one red herring), and **Filbert the filing parrot** in a **cage**. Door (-> office).

## Characters
| Who | Look | Personality / role |
|---|---|---|
| **Guybrush** | CMI costume 2 (decoded from AKOS) | player |
| **Agatha Stampwell**, head clerk | tall grey beehive with a quill in it, half-moon spectacles on a chain, frilly blouse, cardigan, a brass **hook hand fitted with a rubber stamp (DENIED)** | deadpan, rule-bound, "Next." Lost the APPROVED stamp in 1672 and has been denying ever since |
| **Old Mort** | skeleton in a tattered captain's coat and tricorn, on the bench, clutching **ticket #7** | waiting since 1654 ("I was thirty-two. I had hair. And skin."), grumpy, VERY ticklish |
| **Jacques-Louis Daubé**, license portraitist | tall, skinny, huge curly mustache, beret, paint-spattered smock, palette | flamboyant, French, "I paint only ze truth!" |
| **Filbert**, the filing parrot | green parrot, tiny clerk's visor | knows where every form is filed; recites form numbers |
| **Inky**, the squid | small pink squid in the fountain | timid; inks when frightened |
| **Harbor Master** | voice + eyes behind the tower shutter | "No license, no leaving. The gate stays down." |

## Items (inventory)
| id | name | from | used for |
|---|---|---|---|
| ticket_big | ticket number 9,999,999 | office: dispenser | swapped into Mort's hand |
| ticket_7 | ticket number 7 | office: Mort (tickle + swap) | lets Agatha serve you |
| chicken | rubber chicken (no pulley) | records: Lost & Found | nothing: the red herring |
| feather | long feather | records: feather duster | tickle Mort; + ink -> quill |
| form | Form 27-B/6 | office: form rack | parrot follows form holders; + quill -> completed form |
| form_done | completed Form 27-B/6 | combine | license requirement |
| bottle | empty ink bottle | records: desk | + inky fountain -> ink |
| ink | bottle of squid ink | harbor: fountain after the squid inks | + feather -> quill; + stamp -> inked stamp |
| quill | inked quill | feather + ink | + form -> completed form (can also tickle) |
| menu | calamari menu | harbor: notice board | show to the squid -> ink |
| eyepatch | eye patch | records: Lost & Found | portrait |
| parrot | Filbert | records: cage (holding a form) | portrait |
| lime | lime | harbor: stall (unlimited) | eat during the portrait -> scowl |
| portrait | license portrait | harbor: painter | license requirement |
| stamp | APPROVED stamp | records: drawer L ("Lost") | + ink -> inked stamp |
| stamp_inked | inked APPROVED stamp | combine | give to Agatha |
| license | Pirate License | office: Agatha | show to the Harbor Master -> ending |

Item combinations: feather+ink, quill+form (a form-filling dialogue), stamp+ink; plus many
wrong combinations with jokes.

## Puzzle dependency chart
```
            GOAL: leave Port Papeleo with the clue to Blackwood's treasure
                               |
        clue: Blackwood's 1654 portrait (ask the painter about the old, dark sample) + the lime
        crates' stencil -> Isla Agria; either order. Taking the first lime makes Guybrush notice the
        crates ("Scurvy-B-Gone limes. 'Fresh from ISLA AGRIA'"), so the portrait is the only thing to
        find. Without it Guybrush won't show his license yet ("Not yet. I didn't come all this way...").
                               |
                 show license to Harbor Master (harbor)
                               |
             Agatha stamps the license (office) <-- inked APPROVED stamp
                /           |             \              \
        ticket #7     completed form     portrait      stamp + ink
            |            /      \         /  |  \          |      \
     tickle Mort     quill      form   patch parrot lime  drawer L  ink
     (feather) +       |          |      |     |     |   (records) (see below)
     ticket_big   feather+ink   rack   L&F  cage+form stall
     (dispenser)                       (rec) (records) (harbor)

 ink:  menu (notice board) -> show to squid -> fountain turns black -> fill empty bottle (records desk)
 parrot: needs the form (blank or completed) in hand; "Squawk! Paperwork first!"
 portrait: give patch + parrot to the painter, then EAT the lime when he demands a scowl
```
Order is free (parallel requirements, like MI1's three trials); no dead ends: limes are
unlimited, forms are unlimited, the ink bottle is reusable, Agatha keeps what you already gave her.

Hints are in the world more than in the dialogue: the painter's sample portraits (all one-eyed,
parroted, scowling), the notice board ("LOST: one eye ... contact the Lost and Found"), the painter
during the pose ("think SOUR"), Mort giggling at the door draft on the first visit and "I'm VERY
ticklish", Agatha (APPROVED stamp lost "in the Archives in 1672"), drawer S ("See L."), the menu
("FRIED CALAMARI") and the squid that looks at Guybrush "like I'm a waiter". The painter no longer
says where to find things ("I am a painter, not a treasure map").

## Script (cutscenes)
**Opening**: title card, then sunset over the harbor. Guybrush rows in and ties up; CLANK, SPLASH:
the sea gate slams down behind him. The Harbor Master's shutter snaps open: "Welcome to Port Papeleo!
Pleasure or piracy?" / "Piracy! I'm Guybrush Threepwood, mighty pirate!" / "License, please." /
"...License?" / "Since when does piracy need a license?" / "Since 1650. We only got the gate on
Tuesday. No license, no leaving." *Shutter slams.* Guybrush: "How hard can it be?" (Before the gate:
"Port Papeleo! The last place anybody saw Captain Mortimer Blackwood and his legendary treasure.")

**Squid**: Guybrush unfolds the menu: "Tonight's special: FRIED CALAMARI!" The squid goes
pale, inks the whole basin black and hides.

**Portrait**: the painter poses Guybrush (patch, parrot), demands a scowl; Guybrush eats the
lime; "MAGNIFIQUE! Such fury! Such bile!"; full-screen reveal of the painting.

**Approval**: Agatha screws the APPROVED stamp onto her hook: "Hmm. It fits." STAMP. "APPROVED."
"How odd. I feel almost cheerful." "It will pass." ... "I already do. Next!"

**Blackwood's portrait**: full-screen close-up of the 1654 license portrait (`game/art/blackwood_portrait.jpg`),
re-viewable by looking at the sample portraits; Guybrush's own portrait is re-viewable from the inventory.

**Ending**: the Harbor Master reads the license twice, the sea gate rattles up, "Next stop: Isla Agria!",
Guybrush rows into the sunset. Cut to the office: "Now serving... number eight." Mort: "EIGHT?! What happened
to SEVEN?!" THE END.

## Extended Edition (prototype, 2026-10-02)
Chosen over the title card ("License to Pillage" / "...: Extended Edition"), like CMI's Regular / Mega-Monkey.
Everything is additive: the 3-room puzzle chain is the same in both editions; extended content is marked
`edition: 'extended'`. Past the painter (harbor's east edge):
- **Market alley** (`alley`, 960 wide): the souvenir shack (sign: "SOUVENIRS / OFFICIALLY LICENSED"; fake "Genuine Captain Blackwood treasure maps"),
  the C.P.L.A. barrier "ROAD CLOSED PENDING FORM 12-C" (Filbert's cracker form), notice boards with a Sam & Max
  WANTED poster, the market stall (calamari shortage), the Salty Squid's door, the path down to the beach.
- **Salty Squid tavern** (`tavern`, a cellar taproom): FRIED CALAMARI sold out, grog tap, squid carving, fireplace,
  porthole onto the sea gate; **Murray** (CMI's own skull, costume 12) runs the COMPLAINTS department and is the
  optional hint line (`game/scripts/murray.js`: every complaint nudges toward the first missing requirement,
  vague then plain; after the license, toward Blackwood's clue).
- **Beach** (`beach`, 960 wide, animated surf): a cove inside the reef (the Coral Teeth), so no way out but the sea
  gate; the leaning lighthouse ("renew my light license. Back in 1673"), the chained impounded dinghy, the wreck
  ("It looks like the gate won"), the tide pool of Inky's relatives, the tiny distant gate.
Later stops on Blackwood's trail (Isla Agria...) would be new chapters.
Status (2026-10-02): playable start to finish (`EDITION=extended tests/walkthrough.py`), but exploration only: no
new items or puzzles, Murray is the only new character (~140 new lines). Agreed direction for later (user: "sounds
good, maybe we'll continue the extended version more later"): a puzzle per extended room, starting with the
impounded dinghy needing its own C.P.L.A. boat registration (the DMV joke paying off) and a second Isla Agria clue in
the tavern (e.g. a sailor who has been there); optional new characters (tavern keeper, fisherman, a rival treasure
hunter); maybe an alternative way out past the reef in the repaired dinghy.

## Interface (as CMI)
- Left click: walk. Hold left on a hotspot: the verb coin (hand / skull / parrot) appears
  centered ~46 px above the cursor; release on an icon. Label at the bottom center:
  "<verb> <object>" (verbs per object: pick up, use, open, push, talk to, eat, ...).
- Right click: treasure chest inventory; click an item to hold it as the cursor; click it on
  a hotspot ("use X with Y" / "give X to Y") or on another item to combine. Right click drops it.
- Dialogue choices: bottom left, white, hovered line red. Speech above the speaker's head in
  the speaker's color. `.` skips a line, Esc skips a cutscene. F5: save/load/options.

"""Bring-your-own-game: everything the toolkit needs from The Curse of Monkey Island is read from the player's
own installed copy, on the player's machine (nothing of CMI is shipped with the mod).

  gamedir.py   find and check a CMI installation (Steam / GOG / CD copy), a case-normalized view of its files
  decoders.py  CMI image formats: AKOS codec 1 costume cels, BOMP object images, NUT codec 44 fonts, palettes
  upscale.py   1x -> 4x for the HD view (pixel-art aware) when no HD pack exists
  extract.py   writes cmi/ (interface, fonts, low-res set, palette, Guybrush) and per-game extras; CLI
"""

"""Basic English filter for hateful and vulgar player names.

Not exhaustive — it stops the common cases, including the usual dodges:
spacing or punctuation between letters ("f.u.c.k"), leetspeak ("sh1t"),
stretched letters ("fuuuck") and camel-cased words ("BigJerkFace").

Two kinds of terms:
  * SUBSTRING_TERMS (regexes) are distinctive enough to block wherever they
    appear in the letters of a name, with a small allow-list for innocent
    words that happen to contain one ("Scunthorpe", "therapist") and
    lookarounds for common names ("Yamashita", "Fukuda", "swank").
  * WORD_TERMS are short or ambiguous, so they only block as a whole word
    (or the whole name), or its plural — "Dickens", "Cassidy", "Spicer" and
    "Hancock" stay allowed.
"""

from __future__ import annotations

import re

# Hate speech: slurs and extremist terms.
_HATE_SUBSTRINGS = [
    "nigger", "nigga", "niglet", "faggot", "fagot", "tranny", "shemale",
    "retard", "wetback", "beaner", "raghead", "towelhead", "sandnigger",
    "chinaman", "hitler", "himmler", "goebbels", "kkk", "whitepower",
    "whitepride", "siegheil", "heilhitler", "killyourself", "gaschamber",
]
_HATE_WORDS = {
    "nazi", "nazis", "fag", "fags", "dyke", "kike", "spic", "spick", "chink",
    "gook", "coon", "jap", "paki", "wop", "gypo", "gyppo", "heil", "kys",
    "homo", "negro", "tard", "nig", "niggers",
}

# Profanity / vulgarity. (Regexes: "shit" but not Yamashita / Yoshitaka,
# "fuk" but not Fukuda / Fukushima, "wank" but not swank.)
_VULGAR_SUBSTRINGS = [
    "fuck", r"fuk(?!u)", "phuck", r"shit(?!a)", "cunt", "bitch", "whore",
    "slut", "twat", r"(?<!s)wank", "bastard", "asshole", "arsehole",
    "dumbass", "jackass", "dickhead", "cocksuck", "motherf", "jizz", "pussy",
    "penis", "vagina", "porn", "boner", "bollock", "dildo", "rapist",
    "blowjob", "handjob", "cumshot", "titties", "felch", "smegma",
]
_VULGAR_WORDS = {
    "ass", "arse", "dick", "dicky", "cock", "prick", "cum", "tit", "tits",
    "titty", "boob", "boobs", "anal", "anus", "piss", "pissed", "crap",
    "damn", "rape", "raped", "raping", "sex", "nude", "nudes", "milf", "hoe",
    "thot", "horny", "fuk",
}

SUBSTRING_TERMS = [re.compile(t) for t in _HATE_SUBSTRINGS + _VULGAR_SUBSTRINGS]
WORD_TERMS = _HATE_WORDS | _VULGAR_WORDS

# Innocent words that contain a substring term.
_ALLOWED_WORDS = [
    "scunthorpe", "therapist", "therapists", "shiitake", "cockburn",
    "assassin", "classic", "passion", "penistone", "pussycat", "dickens",
    "snigger", "sniggering", "niggle", "niggling", "matsushita",
]

# Characters people swap in for letters.
_LEET = str.maketrans({
    "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "6": "g", "7": "t",
    "8": "b", "9": "g", "@": "a", "$": "s", "!": "i", "+": "t", "|": "i",
    "€": "e", "£": "l",
})

# Number codes used as hate symbols (checked before leetspeak).
_HATE_NUMBERS = ["1488", "14/88", "14 88"]

_CAMEL_SPLIT = re.compile(r"(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])")


def _collapse(s: str, keep: int) -> str:
    """Collapse runs of the same letter to at most `keep` (1 or 2)."""
    return re.sub(r"(.)\1+", lambda m: m.group(1) * min(keep, len(m.group(0))), s)


def _words(name: str) -> list[str]:
    """Lower-cased words of a name, split on non-letters and camel case."""
    words: list[str] = []
    for chunk in re.split(r"[^A-Za-z0-9@$!+|€£]+", name):
        for part in _CAMEL_SPLIT.split(chunk):
            w = part.translate(_LEET).lower()
            w = re.sub(r"[^a-z]", "", w)
            if w:
                words.append(w)
    return words


def _word_variants(w: str) -> set[str]:
    """A word, stretched letters squeezed, and its singular. (Only a plural
    "s" is stripped — "-y" / "-er" would turn "Spicy" / "Spicer" into slurs.)"""
    out = {w, _collapse(w, 2)}
    for v in list(out):
        if v.endswith("s") and len(v) > 3:
            out.add(v[:-1])
    return out


def is_name_allowed(name: str) -> bool:
    """False if the name contains hateful or vulgar language."""
    if not name:
        return True
    raw = name.lower()
    if any(code in raw for code in _HATE_NUMBERS):
        return False

    # Every letter of the name run together, innocent words removed.
    squashed = re.sub(r"[^a-z]", "", name.translate(_LEET).lower())
    for ok in _ALLOWED_WORDS:
        squashed = squashed.replace(ok, "")
    for variant in {squashed, _collapse(squashed, 1), _collapse(squashed, 2)}:
        if any(term.search(variant) for term in SUBSTRING_TERMS):
            return False
        if variant in WORD_TERMS:
            return False

    for w in _words(name):
        if w in _ALLOWED_WORDS:
            continue
        if _word_variants(w) & WORD_TERMS:
            return False
    return True


NAME_REJECTED_MESSAGE = "That name isn't allowed — please choose another."

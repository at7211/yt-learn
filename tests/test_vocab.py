from pipeline.llm import FakeProvider, ProviderError
from pipeline.vocab import (
    VOCAB_SCHEMA,
    VOCAB_SYSTEM,
    expand_hits,
    find_spans,
    norm,
    pick_vocab,
    validate_hits,
    vocab_user_prompt,
)

TOKENS = [
    ["He's", "a", "thug", "and", "Hoffa."],
    ["Run", "your", "mouth,", "thug", "exposed."],
    ["A", "self-made", "thug", "who", "ran."],
    ["Never", "talked", "again", "about", "it."],
]
RAW = [
    "he's", "a", "thug", "and", "hofa",
    "run", "your", "mouth", "thug", "exposed",
    "a", "self-made", "thug", "who", "ran",
    "never", "talked", "again", "about", "it",
]
WORDS = [{"t": i * 0.5, "e": i * 0.5 + 0.2, "w": w, "timed": True} for i, w in enumerate(RAW)]
CUES = [
    {"a": 5 * k, "b": 5 * k + 4, "tokens": t, "zh": "", "en": " ".join(t)}
    for k, t in enumerate(TOKENS)
]


def item(term, cues, pos="n.", ipa=None, zh="義"):
    return {"term": term, "pos": pos, "ipa": ipa, "zh": zh, "cues": cues}


def hits(out, i=0):
    return [(h["cue"], h["a"], h["b"]) for h in out[i]["hits"]]


def test_norm_strips_outer_punctuation_keeps_inner():
    assert norm("Run your mouth,") == "run your mouth"
    assert norm("  He's   SELF-made. ") == "he's self-made"
    assert norm('"Hello,"  (world)!') == "hello world"


def test_hit_text_mismatch_dropped():
    out = validate_hits([item("thug", [3]), item("mouth", [3])], CUES, WORDS)
    assert out == []
    out = validate_hits([item("thug", [0, 3])], CUES, WORDS)
    assert hits(out) == [(0, 2, 2)]


def test_hit_bad_shape_dropped():
    raw = [
        item("thug", "0"),
        item("thug", [True]),
        item("thug", [0], pos="noun"),
        "thug",
        item("", [0]),
        {**item("thug", [0]), "zh": 5},
        item("thug", [0.5]),
    ]
    assert validate_hits(raw, CUES, WORDS) == []
    assert validate_hits("nope", CUES, WORDS) == []


def test_hit_outside_cue_dropped():
    out = validate_hits([item("thug", [99, -1, 1])], CUES, WORDS)
    assert hits(out) == [(1, 8, 8)]
    assert validate_hits([item("thug", [99])], CUES, WORDS) == []


def test_hit_matches_corrected_token_when_raw_is_asr_typo():
    assert find_spans("Hoffa", CUES[0], WORDS) == [(4, 4)]
    assert find_spans("hofa", CUES[0], WORDS) == [(4, 4)]
    out = validate_hits([item("Hoffa", [0]), item("hofa", [0])], CUES, WORDS)
    assert [hits(out, 0), hits(out, 1)] == [[(0, 4, 4)], [(0, 4, 4)]]


def test_no_inflection_matching():
    assert find_spans("expose", CUES[1], WORDS) == []
    assert find_spans("exposed", CUES[1], WORDS) == [(9, 9)]
    assert validate_hits([item("expose", [1])], CUES, WORDS) == []


def test_find_spans_multiword_and_inner_punctuation():
    assert find_spans("run your mouth", CUES[1], WORDS) == [(5, 7)]
    assert find_spans("self-made", CUES[2], WORDS) == [(11, 11)]
    assert find_spans("he's", CUES[0], WORDS) == [(0, 0)]


def test_expand_finds_other_exact_occurrences_within_a_cue():
    vocab = validate_hits([item("thug", [1])], CUES, WORDS)
    assert hits(vocab) == [(1, 8, 8)]
    out = expand_hits(vocab, CUES, WORDS)
    assert hits(out) == [(0, 2, 2), (1, 8, 8), (2, 12, 12)]
    # spans crossing a cue boundary are never matched
    cross = [{"term": "exposed a", "pos": "phr.", "ipa": None, "zh": "x",
              "hits": [{"cue": 1, "a": 9, "b": 9}]}]
    assert expand_hits(cross, CUES, WORDS)[0]["hits"] == [{"cue": 1, "a": 9, "b": 9}]
    assert find_spans("exposed a", CUES[1], WORDS) == []


def test_ipa_normalized_and_phrases_have_none():
    out = validate_hits([
        item("thug", [0], ipa="/θʌɡ/"),
        item("Hoffa", [0], ipa=""),
        item("run your mouth", [1], pos="idiom", ipa="/x/"),
    ], CUES, WORDS)
    assert [o["ipa"] for o in out] == ["/θʌɡ/", None, None]
    assert set(out[0]) == {"term", "pos", "ipa", "zh", "hits"}


def test_ids_ordered_by_first_hit_time():
    prov = FakeProvider([{"vocab": [
        item("mouth,", [1], zh="嘴"),
        item("Hoffa", [0], zh="霍法"),
        item("exposed", [1], pos="v.", zh="揭露"),
    ]}])
    out = pick_vocab(CUES, WORDS, prov)
    assert [(o["id"], o["term"]) for o in out] == [(0, "Hoffa"), (1, "mouth,"), (2, "exposed")]
    assert out[0]["hits"] == [{"cue": 0, "a": 4, "b": 4}]
    assert len(prov.calls) == 1
    system, user, schema = prov.calls[0]
    assert system == VOCAB_SYSTEM and schema == VOCAB_SCHEMA
    assert user == vocab_user_prompt(CUES, WORDS, 5)


def test_duplicate_terms_merged():
    prov = FakeProvider([{"vocab": [
        item("thug", [0], zh="惡棍"),
        item("Thug,", [2], zh="暴徒"),
    ]}])
    out = pick_vocab(CUES, WORDS, prov)
    assert len(out) == 1
    assert out[0]["id"] == 0 and out[0]["zh"] == "惡棍"
    assert [(h["cue"], h["a"]) for h in out[0]["hits"]] == [(0, 2), (1, 8), (2, 12)]


def test_max_items_cap():
    prov = FakeProvider([{"vocab": [
        item("Hoffa", [0]), item("thug", [0]), item("mouth", [1]),
    ]}])
    out = pick_vocab(CUES, WORDS, prov, max_items=2)
    assert [(o["id"], o["term"]) for o in out] == [(0, "thug"), (1, "Hoffa")]
    assert "目標 2 個" in prov.calls[0][1]


def test_user_prompt_lists_numbered_cues_and_counts():
    u = vocab_user_prompt(CUES, WORDS, 5)
    assert "#0: He's a thug and Hoffa." in u
    assert "#3: Never talked again about it." in u
    assert "20" in u and "目標 5 個" in u


def test_provider_error_returns_empty(capsys):
    assert pick_vocab(CUES, WORDS, FakeProvider([ProviderError("boom")])) == []
    err = capsys.readouterr()
    assert err.out == "" and err.err.count("\n") == 1 and "boom" in err.err


def test_bad_response_returns_empty(capsys):
    assert pick_vocab(CUES, WORDS, FakeProvider([{"vocab": "x"}])) == []
    assert capsys.readouterr().err.count("\n") == 1


def _mk(raw_words, tokens):
    words = [{"t": i * 0.5, "e": i * 0.5 + 0.2, "w": w, "timed": True} for i, w in enumerate(raw_words)]
    cue = {"a": 0, "b": len(raw_words) - 1, "tokens": tokens, "zh": "", "en": " ".join(tokens)}
    return cue, words


def test_find_spans_does_not_resplit_tokens():
    cue, words = _mk(["um", "gonna", "be", "a", "real", "thug"],
                     ["Um,", "going to", "be", "a", "real", "thug."])
    assert find_spans("real", cue, words) == [(4, 4)]
    assert find_spans("thug", cue, words) == [(5, 5)]
    assert find_spans("a real", cue, words) == [(3, 4)]
    assert find_spans("going to", cue, words) == []


def test_term_normalizing_to_empty_matches_nothing():
    cue, words = _mk(["well", "...", "ok"], ["Well", "...", "ok"])
    assert find_spans("...", cue, words) == []
    assert find_spans("", cue, words) == []


def test_term_longer_than_cue_no_match():
    cue, words = _mk(["a", "b"], ["a", "b"])
    assert find_spans("a b c", cue, words) == []


def test_overlapping_repeats_each_counted():
    cue, words = _mk(["very", "very", "very"], ["very", "very", "very"])
    assert find_spans("very very", cue, words) == [(0, 1), (1, 2)]

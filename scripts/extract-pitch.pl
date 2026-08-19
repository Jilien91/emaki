use strict;
use warnings;
# Without this the literal ・ below is a byte sequence, while the readings read
# through an encoding layer are characters, so the split silently never fires
# and the three two-reading cards go looking for "なに・なん" as one word.
use utf8;
use JSON::PP;
use Text::ParseWords qw(parse_line);
use Unicode::Normalize qw(NFKC);

# Builds data/pitch.json, the accent type of every card, from UniDic.
#
#   perl scripts/extract-pitch.pl --lex /path/to/lex_3_1.csv
#
# UniDic (NINJAL) is BSD licensed and its aType field is the mora number of the
# accent nucleus, 0 for heiban. Not the NHK-derived datasets that circulate for
# Anki: those come from a commercial dictionary, and this project asked
# permission for its word list rather than taking it.
#
# The 500 MB dictionary is not in this repository and does not need to be. It is
# downloaded once, this runs once, and what ships is a file of about 30 KB.
#   https://clrd.ninjal.ac.jp/unidic_archive/cwj/3.1.0/unidic-cwj-3.1.0.zip
#
# ---------------------------------------------------------------------------
# Matching, and why it is this narrow
#
# Match on surface plus `kana`, UniDic's *written* reading. Not `pron`, which is
# the pronunciation and normalises ハ to ワ for the particle and コウ to コー
# for long vowels; comparing that against this deck's readings would miss. Not
# `lForm` either, which is the lemma's reading rather than this surface's.
#
# So normalisation is deliberately minimal: NFKC, hiragana to katakana, compare
# exactly. No folding of long vowels, は/わ, へ/え, を/お or づ/ず. Those are
# pronunciation rules and this is not the pronunciation field.
#
# ---------------------------------------------------------------------------
# Why it dies rather than guesses
#
# An accent pattern shown to a learner is a claim. A wrong one is worse than an
# absent one, because they will remember the pattern long after they have
# forgotten any uncertainty marker attached to it. So every ambiguity stops the
# run and asks for a human decision, recorded with its reason in
# data/pitch-overrides.json, rather than being resolved by picking the first row.

binmode STDOUT, ':encoding(UTF-8)';
binmode STDERR, ':encoding(UTF-8)';

my $LEX        = '';
my $VOCAB      = 'data/vocab.json';
my $OUT        = 'data/pitch.json';
my $OVERRIDES  = 'data/pitch-overrides.json';
my $DRY        = 0;

# Zero-based columns in unidic-cwj-3.1.0/lex_3_1.csv. MeCab reserves the first
# four for surface, left id, right id and cost; UniDic's own features follow.
# Verified against the real file rather than taken from documentation, by
# dumping every column of the 全然 row: kana ゼンゼン at 24, aType 0 at 28.
my ($C_SURFACE, $C_KANA, $C_ATYPE)   = (0, 24, 28);
my ($C_POS1, $C_POS2, $C_POS3, $C_POS4) = (4, 5, 6, 7);
my ($C_LEMMA, $C_GOSHU, $C_LID, $C_LEMMA_ID) = (11, 16, 31, 32);
my ($C_CTYPE, $C_CFORM) = (8, 9);

while (@ARGV) {
    my $a = shift @ARGV;
    if    ($a eq '--lex')       { $LEX       = shift @ARGV // die "--lex needs a path\n" }
    elsif ($a eq '--vocab')     { $VOCAB     = shift @ARGV // die "--vocab needs a path\n" }
    elsif ($a eq '--out')       { $OUT       = shift @ARGV // die "--out needs a path\n" }
    elsif ($a eq '--overrides') { $OVERRIDES = shift @ARGV // die "--overrides needs a path\n" }
    elsif ($a eq '--dry-run')   { $DRY       = 1 }
    else { die "Unknown argument: $a\n" }
}
$LEX or die "--lex is required: the path to unidic-cwj-3.1.0/lex_3_1.csv\n";
-e $LEX or die "$LEX: no such file\n";

sub to_katakana {
    my ($s) = @_;
    $s = NFKC($s);
    $s =~ s/([\x{3041}-\x{3096}])/chr(ord($1) + 0x60)/ge;
    return $s;
}

# ---------------------------------------------------------------------------
# What the deck asks for. The three cards carrying two readings are expanded
# before lookup: ・ is a separator this project invented, not part of any
# reading, and certainly not a mora.

open my $vf, '<:encoding(UTF-8)', $VOCAB or die "$VOCAB: $!\n";
my $vocab = JSON::PP->new->decode(do { local $/; <$vf> });
close $vf;

my (%queries, @wanted);
for my $card (@$vocab) {
    my @readings = split /・/, ($card->{reading} // '');
    @readings or die "Card $card->{id} has no reading\n";
    for my $r (@readings) {
        $r =~ s/^\s+|\s+$//g;
        my $key = $card->{word} . "\t" . to_katakana($r);
        push @wanted, { id => $card->{id}, word => $card->{word}, reading => $r,
                        meaning => $card->{meaning}, key => $key };
        $queries{$key} = undef;
    }
}
printf "deck: %d cards, %d readings, %d unique surface+kana queries\n",
    scalar @$vocab, scalar @wanted, scalar keys %queries;

# ---------------------------------------------------------------------------
# One pass over UniDic, collecting every aType seen for each wanted key.
#
# parse_line rather than split: aType can itself be a comma-separated list, so
# a naive split silently shifts every field after it.

my %seen;
open my $lf, '<:encoding(UTF-8)', $LEX or die "$LEX: $!\n";
my $rows = 0;
while (my $line = <$lf>) {
    $rows++;
    next unless $line =~ /\S/;
    # Cheap pre-filter: the surface is the first field, so a row whose line does
    # not start with a wanted word cannot match. Saves parsing 879k rows fully.
    my ($surface) = $line =~ /^([^,]*)/;
    next unless defined $surface && length $surface;
    my @f = parse_line(qr/,/, 0, $line);
    next unless @f > $C_LEMMA_ID;
    my $key = $f[$C_SURFACE] . "\t" . ($f[$C_KANA] // '');
    next unless exists $queries{$key};

    my $atype = $f[$C_ATYPE] // '*';
    $atype =~ s/\s+//g;
    # A comma inside aType is UniDic listing alternative patterns for one
    # lexeme, commonest first. That is one answer, not two rows disagreeing,
    # and treating it as a disagreement invents conflicts that do not exist.
    my @atypes = $atype eq '*' ? () : grep { /^\d+$/ } split /,/, $atype;

    # NFKC-generated duplicates of an entry share its lid, so keying on lid
    # collapses them instead of counting the same lexeme twice.
    my $lid = $f[$C_LID] // '';
    next if $seen{$key}{$lid};
    $seen{$key}{$lid} = {
        atypes   => \@atypes,
        pos      => [ grep { defined && $_ ne '*' } @f[$C_POS1, $C_POS2, $C_POS3, $C_POS4] ],
        lemma    => $f[$C_LEMMA] // '',
        goshu    => $f[$C_GOSHU] // '',
        ctype    => $f[$C_CTYPE] // '',
        cform    => $f[$C_CFORM] // '',
        lid      => $lid,
        lemma_id => $f[$C_LEMMA_ID] // '',
    };
}
close $lf;
printf "unidic: %d rows scanned, %d of %d queries matched\n",
    $rows, scalar(keys %seen), scalar keys %queries;

# ---------------------------------------------------------------------------
# Human decisions, if any have been recorded.

my $ov = {};
if (-e $OVERRIDES) {
    open my $of, '<:encoding(UTF-8)', $OVERRIDES or die "$OVERRIDES: $!\n";
    $ov = JSON::PP->new->decode(do { local $/; <$of> });
    close $of;
}
my $omit = $ov->{_expected_omissions} || {};

# ---------------------------------------------------------------------------
# Resolve. Four outcomes, and only the first produces a pattern.

# Cards that really are proper nouns, so the rule below must not quietly strip
# their only candidate. 日本 is one; assuming a vocabulary deck has none was a
# premise that this deck disproves on card 51.
my $proper = $ov->{_proper_nouns} || {};

my (%pitch, @conflicts, @no_row, @no_atype, @omitted, @stale_omissions);
for my $w (@wanted) {
    my $found = $seen{ $w->{key} };
    # The meaning is on the line because it is what decides these: which lexeme
    # a card intends is a question about the card, not about the dictionary.
    my $tag   = sprintf 'card %-4d %s %s = %s', $w->{id}, $w->{word}, $w->{reading}, $w->{meaning};
    my $okey  = "$w->{id}:$w->{reading}";

    if (!$found) {
        if ($omit->{$okey}) { push @omitted, $tag; next }
        push @no_row, $tag;
        next;
    }

    my @cands = grep { @{ $_->{atypes} } } values %$found;
    if (!@cands) {
        # UniDic knows the word but records no accent for it.
        if ($omit->{$okey}) { push @omitted, $tag; next }
        push @no_atype, $tag;
        next;
    }

    # A proper-name row colliding with an ordinary word is the single commonest
    # false conflict: 時 read トキ is both the noun and the given name Toki. Drop
    # the name only when an ordinary reading also exists, so a card that really
    # is a proper noun is never silently emptied.
    my @common = grep { !grep { $_ eq '固有名詞' } @{ $_->{pos} } } @cands;
    if (@common && @common != @cands && !$proper->{$okey}) {
        @cands = @common;
    } elsif (!@common && !$proper->{$okey}) {
        push @conflicts, "$tag: only proper-name entries; add to _proper_nouns if that is right";
        next;
    }

    # The same trick again for classical Japanese. 赤い has three rows: the
    # modern adjective in two inflections, both aType 0, and a 文語形容詞-ク
    # literary form at aType 1. Same lemma, same surface, different century.
    # A beginner deck teaches the modern one, so drop 文語 rows when a modern
    # row exists, and never when it is all there is.
    my @modern = grep { $_->{ctype} !~ /^文語/ } @cands;
    @cands = @modern if @modern && @modern != @cands;

    if (my $decided = $ov->{$okey}) {
        # A recorded decision names a lexeme, not a number. Checking the number
        # alone would let a different homograph that happens to share it make a
        # stale note look valid.
        my ($pick) = grep { $_->{lemma_id} eq $decided->{lemma_id} } @cands;
        unless ($pick) {
            push @conflicts, "$tag: override names lemma_id $decided->{lemma_id}, "
                           . "no longer among " . join(', ', map { $_->{lemma_id} } @cands);
            next;
        }
        push @{ $pitch{ $w->{id} } },
            { reading => $w->{reading}, atypes => $pick->{atypes}, lemma_id => $pick->{lemma_id} };
        next;
    }

    my %distinct = map { join(',', @{ $_->{atypes} }) => 1 } @cands;
    if (keys %distinct > 1) {
        # Every candidate, not one per accent value. Two lexemes can share an
        # accent, and collapsing on it hides the one that answers the question:
        # あれ has 代名詞 and 動詞 rows both at [0], and only the pronoun is the
        # word on the card.
        # One line per lexeme, not per inflected row: 居る appears half a dozen
        # times across its conjugations and they are all the same decision. The
        # lemma is what tells 居る from 要る from 射る, which is the whole
        # question, so it goes in front.
        my %byLexeme;
        $byLexeme{ $_->{lemma_id} . '|' . join(',', @{ $_->{atypes} }) } //= $_ for @cands;
        push @conflicts, "$tag: " . join('  |  ',
            map { sprintf '%s [%s] %s %s', $_->{lemma}, join(',', @{ $_->{atypes} }),
                  join('/', @{ $_->{pos} }) || '?', $_->{lemma_id} }
            sort { join(',', @{ $a->{atypes} }) cmp join(',', @{ $b->{atypes} })
                   || $a->{lemma_id} <=> $b->{lemma_id} } values %byLexeme);
        next;
    }
    # Bidirectional: something on the omissions list that now resolves means the
    # list is out of date, and a silently shrinking allowlist hides drift.
    push @stale_omissions, $tag if $omit->{$okey};
    # %distinct is now a set of accent strings, so take the lexeme from the
    # candidates themselves. They all agree on the accent at this point; the
    # lemma_id is recorded so a later run can tell if the entry has changed.
    my ($only) = @cands;
    push @{ $pitch{ $w->{id} } },
        { reading => $w->{reading}, atypes => $only->{atypes}, lemma_id => $only->{lemma_id} };
}

my @missing = (@no_row, @no_atype);
printf "\nresolved: %d cards\nomitted (expected): %d\nconflicts: %d\n"
     . "unmatched: %d (%d with no surface+kana row, %d matched but aType is *)\n",
    scalar(keys %pitch), scalar @omitted, scalar @conflicts,
    scalar @missing, scalar @no_row, scalar @no_atype;

if (@stale_omissions) {
    print "\nThese are on the expected-omissions list but now resolve. Remove them:\n";
    print "  $_\n" for @stale_omissions;
}
if (@conflicts) {
    print "\nConflicts needing a human decision in $OVERRIDES:\n";
    print "  $_\n" for @conflicts;
}
if (@missing) {
    my $n = @missing > 40 ? 40 : @missing;
    print "\nNo accent available. A multi-token phrase belongs on the omissions list;\n"
        . "a single word here deserves investigating before it is written off:\n";
    print "  $_\n" for @missing[0 .. $n - 1];
    printf "  ... and %d more\n", scalar(@missing) - $n if @missing > $n;
}

die "\nRefusing to write $OUT while " . (scalar @conflicts) . " conflict(s) and "
  . (scalar @missing) . " unmatched reading(s) remain, and "
  . (scalar @stale_omissions) . " stale omission(s).\n"
  . "Record each decision in $OVERRIDES with its reason, then rerun.\n"
    if @conflicts || @missing || @stale_omissions;

if ($DRY) { print "\n--dry-run: not writing $OUT\n"; exit 0 }

open my $out, '>:encoding(UTF-8)', $OUT or die "$OUT: $!\n";
print $out JSON::PP->new->canonical->pretty->encode({
    _source  => 'UniDic 3.1.0 (NINJAL, BSD), field aType',
    _meaning => 'atype is the mora number carrying the accent nucleus; 0 is heiban',
    _built   => scalar(gmtime) . ' UTC',
    pitch    => \%pitch,
});
close $out;
printf "\nwrote %s (%d cards)\n", $OUT, scalar keys %pitch;

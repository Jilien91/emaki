use strict;
use warnings;
use JSON::PP;
use File::Path qw(make_path);
use File::Temp qw(tempfile);
use File::Copy qw(copy);

# Generates word audio with Azure's neural Japanese voices, so the app ships its
# own sound instead of depending on what a user has installed. The device voices
# are the problem this replaces: on Windows the local one is flat and old, the
# good ones are network voices, and "install a language pack first" is not
# something a user will do.
#
#   export AZURE_SPEECH_KEY=...
#   export AZURE_SPEECH_REGION=uksouth
#   perl scripts/gen-audio.pl --limit 20    # both voices, first 20 words
#   perl scripts/gen-audio.pl               # both voices, all 1500
#   perl scripts/gen-audio.pl --only f      # just the female set
#   perl scripts/gen-audio.pl --id 30       # one card, both voices, replaced
#
# --id is the one to reach for after hearing a word come out wrong: fix its
# entry in data/pronunciation.json, regenerate that card, listen again. It
# implies --force, because naming a card means replacing it, and it dies on an
# id that matches no card rather than quietly doing less than you asked.
#
# Two voices, written to audio/f/<id>.mp3 and audio/m/<id>.mp3, so a learner can
# pick. Resumable: a file already present is skipped, so an interrupted run
# costs nothing to restart. --force regenerates, which is what you want after
# changing a voice.
#
# The deck is about 4,900 characters per voice against a 500,000/month free
# tier, so generating both is still free.
#
# curl rather than LWP on purpose: LWP::Protocol::https is not installed here
# and requiring it would be the same "install something first" tax.

binmode STDOUT, ':encoding(UTF-8)';
binmode STDERR, ':encoding(UTF-8)';

# Two sets, because HD is a regional privilege rather than a setting. The HD
# voices only exist in some regions — westeurope, francecentral, swedencentral,
# eastus, eastus2, westus2, canadacentral, centralindia, southeastasia — and a
# resource anywhere else answers 400 with an empty body, which is a miserable
# error to diagnose. uksouth is one of the regions without them.
#
# standard: available in every TTS region, and supports more SSML than HD does,
#   including <prosody> as well as the <phoneme> the accent overrides need.
# hd:       better, and DragonHD rather than HD Omni because Omni drops
#   <phoneme> and would silently disable every override in pronunciation.json.
#   Keita has no HD version, hence Masaru for the male voice.
#
# Check what a region actually has before assuming:
#   curl -H "Ocp-Apim-Subscription-Key: $AZURE_SPEECH_KEY" \
#     https://$AZURE_SPEECH_REGION.tts.speech.microsoft.com/cognitiveservices/voices/list
my %VOICE_SETS = (
    standard => {
        f => { label => 'Nanami', gender => 'female', azure => 'ja-JP-NanamiNeural' },
        m => { label => 'Keita',  gender => 'male',   azure => 'ja-JP-KeitaNeural' },
    },
    # Casing taken from the region's own voices/list rather than the docs, which
    # print these as ja-jp-. The API reports ja-JP-.
    hd => {
        f => { label => 'Nanami', gender => 'female', azure => 'ja-JP-Nanami:DragonHDLatestNeural' },
        m => { label => 'Masaru', gender => 'male',   azure => 'ja-JP-Masaru:DragonHDLatestNeural' },
    },
);
my $SET = 'standard';

my $FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
my $LIMIT  = 0;      # 0 = every card
my $FORCE  = 0;
my $ONLY   = '';     # '' = every voice
my @IDS;             # empty = every card; --id is repeatable
my $OUTDIR = 'audio';
my $MANIFEST = 'data/audio.json';
my $PRONUNCIATION = 'data/pronunciation.json';
my $MAX_ATTEMPTS = 4;

while (@ARGV) {
    my $arg = shift @ARGV;
    if    ($arg eq '--id')     { push @IDS, (shift @ARGV // die "--id needs a value\n") }
    elsif ($arg eq '--limit')  { $LIMIT  = shift @ARGV // die "--limit needs a value\n" }
    elsif ($arg eq '--only')   { $ONLY   = shift @ARGV // die "--only needs a value\n" }
    elsif ($arg eq '--format') { $FORMAT = shift @ARGV // die "--format needs a value\n" }
    elsif ($arg eq '--set')    { $SET    = shift @ARGV // die "--set needs a value\n" }
    elsif ($arg eq '--force')  { $FORCE  = 1 }
    else { die "Unknown argument: $arg\n" }
}
die "--set $SET is not one of: " . join(', ', sort keys %VOICE_SETS) . "\n"
    unless $VOICE_SETS{$SET};
my %VOICES = %{ $VOICE_SETS{$SET} };
die "--only $ONLY is not one of: " . join(', ', sort keys %VOICES) . "\n"
    if $ONLY && !$VOICES{$ONLY};
die "--id and --limit do not make sense together.\n" if @IDS && $LIMIT;
for my $id (@IDS) {
    die "--id $id is not a card number.\n" unless $id =~ /^[0-9]+$/;
}

my $KEY    = $ENV{AZURE_SPEECH_KEY}    or die "AZURE_SPEECH_KEY is not set.\n";
my $REGION = $ENV{AZURE_SPEECH_REGION} or die "AZURE_SPEECH_REGION is not set.\n";
my $ENDPOINT = "https://$REGION.tts.speech.microsoft.com/cognitiveservices/v1";

# ---------------------------------------------------------------------------

open my $vfh, '<:encoding(UTF-8)', 'data/vocab.json' or die "data/vocab.json: $!\n";
my $vocab = JSON::PP->new->decode(do { local $/; <$vfh> });
close $vfh;
die "data/vocab.json held no cards\n" unless ref $vocab eq 'ARRAY' && @$vocab;

# Optional per-card pronunciation overrides, keyed by card id, in Azure's ja-JP
# `sapi` phone set: katakana with ' marking the accent nucleus. This is the
# escape hatch for pitch accent. Azure documents the notation with three
# examples and no rules, so this is deliberately a list of corrections made
# after hearing a word come out wrong, not a bulk layer applied on faith.
#
#   { "8": "ジ'ン" }
#
# A card with no entry is spoken as plain kana and left to the model's own
# accent dictionary, which for common vocabulary is usually right.
my $pron = {};
if (-e $PRONUNCIATION) {
    open my $pfh, '<:encoding(UTF-8)', $PRONUNCIATION or die "$PRONUNCIATION: $!\n";
    $pron = JSON::PP->new->decode(do { local $/; <$pfh> });
    close $pfh;
    my $n = scalar grep { !/^_/ } keys %$pron;
    # The file carries _verified to say whether anyone has established what
    # Azure actually does with this notation. While that is false, an entry in
    # here is a guess that would be baked into audio and only caught by ear,
    # months later, on a card nobody replays. Dying is the point: a warning
    # would be read as documentation and stepped over.
    if ($n && !$pron->{_verified}) {
        die "$PRONUNCIATION has $n override" . ($n == 1 ? '' : 's')
          . " but _verified is false.\n"
          . "Azure's ja-JP phoneme notation has not been established for these voices yet.\n"
          . "Synthesise the card several ways with --id, listen in both voices, then set\n"
          . "_verified true and record what was actually heard.\n";
    }
    print "$PRONUNCIATION: $n pronunciation override" . ($n == 1 ? '' : 's') . "\n" if $n;
}

# The same rule the app uses in speakWord: the reading, not the word, and the
# first of the two where a card carries both. Kana leaves the synthesiser
# nothing to guess at. If this stops matching app.js the audio starts teaching
# a reading the card does not.
sub spoken_text {
    my ($card) = @_;
    my $reading = $card->{reading} // '';
    $reading = (split /・/, $reading)[0] // '';
    $reading =~ s/^\s+|\s+$//g;
    return $reading;
}

sub xml_escape {
    my ($s) = @_;
    $s =~ s/&/&amp;/g;
    $s =~ s/</&lt;/g;
    $s =~ s/>/&gt;/g;
    $s =~ s/"/&quot;/g;
    return $s;
}

sub build_ssml {
    my ($card, $azure) = @_;
    my $text = xml_escape(spoken_text($card));
    my $override = $pron->{ $card->{id} };

    # <phoneme> is supported by DragonHD and by the standard neural voices, but
    # not by HD Omni. Both voices above are fine; a swap to an Omni voice would
    # silently lose every override, so it is worth knowing before changing one.
    my $body = defined $override && length $override
        ? sprintf(q{<phoneme alphabet="sapi" ph="%s">%s</phoneme>}, xml_escape($override), $text)
        : $text;

    # HD voices reject <prosody> outright, which is why speaking rate is applied
    # in the browser instead. enhancePronunciation is HD-only and asks the model
    # to work harder on ambiguous words, which is exactly this deck's problem.
    my $params = $azure =~ /:DragonHD/ ? q{ parameters="enhancePronunciation=true"} : '';

    return join '',
        qq{<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='ja-JP'>},
        qq{<voice name='$azure'$params>}, $body, qq{</voice>},
        qq{</speak>};
}

# Azure answers a bad request with a non-2xx and a text body, which curl -f
# turns into a non-zero exit. The bytes are checked too: a zero-length or HTML
# file landing in audio/ would be a silent defect, a working button that plays
# nothing, invisible until a user reached that card.
sub looks_like_mp3 {
    my ($path) = @_;
    return 0 unless -s $path;
    open my $fh, '<:raw', $path or return 0;
    read $fh, my $magic, 3;
    close $fh;
    return 1 if $magic =~ /^ID3/;
    my @b = unpack 'C*', $magic;
    return 1 if @b >= 2 && $b[0] == 0xFF && ($b[1] & 0xE0) == 0xE0;
    return 0;
}

sub synthesise {
    my ($ssml, $path) = @_;
    my ($tfh, $tname) = tempfile(SUFFIX => '.xml', UNLINK => 1);
    binmode $tfh, ':encoding(UTF-8)';
    print $tfh $ssml;
    close $tfh;

    # Download beside the target, not onto it. Only a verified mp3 is ever moved
    # into place, so a failed attempt cannot damage the file already there.
    my ($ofh, $tmp_out) = tempfile(SUFFIX => '.mp3', UNLINK => 1);
    close $ofh;

    for my $attempt (1 .. $MAX_ATTEMPTS) {
        my @cmd = (
            'curl', '-sS', '-f', '-X', 'POST', $ENDPOINT,
            '-H', "Ocp-Apim-Subscription-Key: $KEY",
            '-H', 'Content-Type: application/ssml+xml; charset=utf-8',
            '-H', "X-Microsoft-OutputFormat: $FORMAT",
            '-H', 'User-Agent: emaki-gen-audio',
            '--data-binary', "\@$tname",
            '-o', $tmp_out,
        );
        if (system(@cmd) == 0 && looks_like_mp3($tmp_out)) {
            # Verified first, moved second. copy rather than rename because the
            # temp file may be on another filesystem.
            copy($tmp_out, $path) or die "Could not put $path in place: $!\n";
            return 1;
        }

        # Never leave a truncated file behind, but never destroy a good one
        # either. Writing straight to $path means a failed run deletes the mp3
        # that was already there, which is how a dry test of --id with a bogus
        # key removed a shipped card's audio and committed the hole.
        unlink $tmp_out if -e $tmp_out;
        if ($attempt < $MAX_ATTEMPTS) {
            my $wait = 2 ** $attempt;   # throttling is the usual cause
            warn "  retry $attempt in ${wait}s\n";
            sleep $wait;
        }
    }
    return 0;
}

# ---------------------------------------------------------------------------

my @todo = @$vocab;
# --id is how you fix one card after hearing it come out wrong. Before it, the
# nearest thing was --limit 30 --force, which regenerates thirty cards to
# replace one, and the difference matters once pitch accent overrides start
# being added one at a time.
#
# It dies rather than warns on an id that matches nothing, and on a duplicate.
# The house rule is that a script reporting fewer changes than expected should
# stop: silently regenerating two cards when three were named would be found
# much later, by ear, on the card that was quietly skipped.
if (@IDS) {
    my %want;
    for my $id (@IDS) {
        die "--id $id given twice.\n" if $want{$id}++;
    }
    @todo = grep { $want{ $_->{id} } } @$vocab;
    if (@todo != keys %want) {
        my %got = map { $_->{id} => 1 } @todo;
        my @missing = sort { $a <=> $b } grep { !$got{$_} } keys %want;
        die "No card with id: " . join(', ', @missing) . "\n";
    }
    $FORCE = 1;   # naming a card means replacing it; it already exists
}
@todo = @todo[0 .. $LIMIT - 1] if $LIMIT && $LIMIT < @todo;
my @keys = $ONLY ? ($ONLY) : (sort keys %VOICES);

printf "%d card%s, %d voice%s: %s\n\n", scalar @todo, (@todo == 1 ? '' : 's'),
    scalar @keys, (@keys == 1 ? '' : 's'),
    join(', ', map { "$_ = $VOICES{$_}{label}" } @keys);

my ($made, $skipped, $chars) = (0, 0, 0);
for my $key (@keys) {
    my $azure = $VOICES{$key}{azure};
    my $dir   = "$OUTDIR/$key";
    make_path($dir) unless -d $dir;
    printf "%s (%s)\n", $VOICES{$key}{label}, $azure;

    for my $card (@todo) {
        my $id   = $card->{id} // die "A card has no id\n";
        my $path = "$dir/$id.mp3";

        if (!$FORCE && looks_like_mp3($path)) { $skipped++; next }

        my $text = spoken_text($card);
        die "Card $id ($card->{word}) has no reading to speak\n" unless length $text;

        synthesise(build_ssml($card, $azure), $path)
            or die "Card $id ($card->{word}, $text) failed after $MAX_ATTEMPTS attempts in $VOICES{$key}{label}.\n"
                 . "Nothing partial was written. Fix the cause and rerun; finished files are skipped.\n";

        $made++;
        $chars += length $text;
        printf "  %4d  %-12s %s%s\n", $id, $text, $card->{word},
            (defined $pron->{$id} ? "  [$pron->{$id}]" : '')
            if $made % 50 == 0 || $made <= 3 || defined $pron->{$id};
    }
}

# The manifest lists what is on disk rather than what this run intended, so a
# partial deck produces a correct manifest and the app falls back for the rest.
my %ids;
for my $key (sort keys %VOICES) {
    next unless -d "$OUTDIR/$key";
    $ids{$key} = [ grep { looks_like_mp3("$OUTDIR/$key/$_.mp3") } map { $_->{id} } @$vocab ];
}

open my $mfh, '>:encoding(UTF-8)', $MANIFEST or die "$MANIFEST: $!\n";
print $mfh JSON::PP->new->canonical->pretty->encode({
    format    => 'mp3',
    generated => scalar(gmtime) . ' UTC',
    voices    => [ map { {
        key    => $_,
        label  => $VOICES{$_}{label},
        gender => $VOICES{$_}{gender},
        azure  => $VOICES{$_}{azure},
        count  => scalar @{ $ids{$_} || [] },
    } } grep { $ids{$_} && @{$ids{$_}} } sort keys %VOICES ],
    ids       => \%ids,
});
close $mfh;

printf "\n%d generated, %d already present, %d characters synthesised\n",
    $made, $skipped, $chars;
for my $key (sort keys %ids) {
    printf "%s: %d of %d cards\n", $VOICES{$key}{label}, scalar @{$ids{$key}}, scalar @$vocab;
}

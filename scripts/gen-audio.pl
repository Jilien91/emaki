use strict;
use warnings;
use JSON::PP;
use File::Path qw(make_path);
use File::Temp qw(tempfile);

# Generates one mp3 per card with Azure's neural Japanese voices, so the app can
# ship its own audio instead of depending on whatever voice a user's device
# happens to have. The device voices are the problem this replaces: on Windows
# the locally installed one is flat and old, the good ones are network voices
# the user has to go and find, and telling somebody to install a language pack
# before they can study is how you lose them.
#
#   export AZURE_SPEECH_KEY=...        # from the Speech resource in Azure
#   export AZURE_SPEECH_REGION=uksouth # the resource's region, not a guess
#   perl scripts/gen-audio.pl --limit 20     # try twenty first, listen to them
#   perl scripts/gen-audio.pl                # then the rest
#
# Resumable: a card whose mp3 already exists is skipped, so a run that dies
# halfway costs nothing to restart. --force regenerates regardless, which is
# what you want after changing voice.
#
# The whole deck is about 4,900 characters. Azure's free tier is 500,000 a
# month, so a full generation is free and the only reason to use --limit is to
# hear the voice before committing to 1500 files.
#
# curl rather than LWP on purpose: LWP::Protocol::https is not installed here
# and requiring it would be the same "go and install something first" tax this
# script exists to remove. curl ships with Windows.

# Progress lines and failure messages both quote the reading being spoken, so
# the handles have to take wide characters or every one of them warns.
binmode STDOUT, ':encoding(UTF-8)';
binmode STDERR, ':encoding(UTF-8)';

my $VOICE  = 'ja-JP-NanamiNeural';
my $FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
my $LIMIT  = 0;      # 0 = every card
my $FORCE  = 0;
my $OUTDIR = 'audio';
my $MANIFEST = 'data/audio.json';
my $MAX_ATTEMPTS = 4;

while (@ARGV) {
    my $arg = shift @ARGV;
    if    ($arg eq '--voice')  { $VOICE  = shift @ARGV // die "--voice needs a value\n" }
    elsif ($arg eq '--limit')  { $LIMIT  = shift @ARGV // die "--limit needs a value\n" }
    elsif ($arg eq '--format') { $FORMAT = shift @ARGV // die "--format needs a value\n" }
    elsif ($arg eq '--force')  { $FORCE  = 1 }
    else { die "Unknown argument: $arg\n" }
}

my $KEY    = $ENV{AZURE_SPEECH_KEY}    or die "AZURE_SPEECH_KEY is not set.\n";
my $REGION = $ENV{AZURE_SPEECH_REGION} or die "AZURE_SPEECH_REGION is not set.\n";
my $ENDPOINT = "https://$REGION.tts.speech.microsoft.com/cognitiveservices/v1";

# ---------------------------------------------------------------------------

open my $vfh, '<:encoding(UTF-8)', 'data/vocab.json' or die "data/vocab.json: $!\n";
my $vocab = JSON::PP->new->decode(do { local $/; <$vfh> });
close $vfh;
die "data/vocab.json held no cards\n" unless ref $vocab eq 'ARRAY' && @$vocab;

make_path($OUTDIR) unless -d $OUTDIR;

# The same rule the app uses in speakWord: the reading, not the word, and the
# first of the two where a card carries both. Kana leaves the synthesiser
# nothing to guess at, which is the entire reason the audio is worth having.
# If this ever stops matching app.js, the audio starts teaching a reading the
# card does not.
sub spoken_text {
    my ($card) = @_;
    my $reading = $card->{reading} // '';
    $reading = (split /・/, $reading)[0] // '';
    $reading =~ s/^\s+|\s+$//g;
    return $reading;
}

sub ssml_escape {
    my ($s) = @_;
    $s =~ s/&/&amp;/g;
    $s =~ s/</&lt;/g;
    $s =~ s/>/&gt;/g;
    return $s;
}

# Azure answers a bad request with a JSON or text body and a non-2xx code, and
# curl -f turns that into a non-zero exit. Checking the bytes too, because a
# zero-length or HTML file that lands in audio/ would be a silent 1500-card
# defect: the button would appear and play nothing.
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
    my ($text, $path) = @_;
    my $ssml = join '',
        qq{<speak version='1.0' xml:lang='ja-JP'>},
        qq{<voice name='$VOICE'>}, ssml_escape($text), qq{</voice>},
        qq{</speak>};

    my ($tfh, $tname) = tempfile(SUFFIX => '.xml', UNLINK => 1);
    binmode $tfh, ':encoding(UTF-8)';
    print $tfh $ssml;
    close $tfh;

    for my $attempt (1 .. $MAX_ATTEMPTS) {
        my @cmd = (
            'curl', '-sS', '-f', '-X', 'POST', $ENDPOINT,
            '-H', "Ocp-Apim-Subscription-Key: $KEY",
            '-H', 'Content-Type: application/ssml+xml; charset=utf-8',
            '-H', "X-Microsoft-OutputFormat: $FORMAT",
            '-H', 'User-Agent: emaki-gen-audio',
            '--data-binary', "\@$tname",
            '-o', $path,
        );
        my $rc = system(@cmd);
        return 1 if $rc == 0 && looks_like_mp3($path);

        unlink $path if -e $path;   # never leave a truncated file behind
        if ($attempt < $MAX_ATTEMPTS) {
            my $wait = 2 ** $attempt;   # 2s, 4s, 8s: throttling is the usual cause
            warn "  retry $attempt in ${wait}s\n";
            sleep $wait;
        }
    }
    return 0;
}

# ---------------------------------------------------------------------------

my @todo = @$vocab;
@todo = @todo[0 .. $LIMIT - 1] if $LIMIT && $LIMIT < @todo;

printf "Voice %s, %d card%s%s\n", $VOICE, scalar @todo, (@todo == 1 ? '' : 's'),
    ($FORCE ? ', forcing regeneration' : '');

my ($made, $skipped, $chars) = (0, 0, 0);
for my $card (@todo) {
    my $id   = $card->{id} // die "A card has no id\n";
    my $path = "$OUTDIR/$id.mp3";

    if (!$FORCE && looks_like_mp3($path)) { $skipped++; next }

    my $text = spoken_text($card);
    die "Card $id ($card->{word}) has no reading to speak\n" unless length $text;

    synthesise($text, $path)
        or die "Card $id ($card->{word}, $text) failed after $MAX_ATTEMPTS attempts.\n"
             . "Nothing partial was written. Fix the cause and rerun; finished cards are skipped.\n";

    $made++;
    $chars += length $text;
    printf "  %4d  %-12s %s\n", $id, $text, $card->{word} if $made % 50 == 0 || $made <= 5;
}

# The manifest is what the app reads to decide whether a card has audio, so it
# lists what is actually on disk rather than what this run intended to make.
# Built by scanning, which means a part-generated deck produces a correct
# manifest and the app falls back to the device voice for the rest.
my @have = sort { $a <=> $b }
           grep { looks_like_mp3("$OUTDIR/$_.mp3") }
           map  { $_->{id} } @$vocab;

my @missing = grep { my $id = $_->{id}; !grep { $_ == $id } @have } @$vocab;

open my $mfh, '>:encoding(UTF-8)', $MANIFEST or die "$MANIFEST: $!\n";
print $mfh JSON::PP->new->canonical->pretty->encode({
    voice     => $VOICE,
    format    => 'mp3',
    generated => scalar(gmtime) . ' UTC',
    count     => scalar @have,
    ids       => \@have,
});
close $mfh;

printf "\n%d generated, %d already present, %d characters synthesised\n",
    $made, $skipped, $chars;
printf "%s lists %d of %d cards%s\n",
    $MANIFEST, scalar @have, scalar @$vocab,
    (@missing ? sprintf(', %d still without audio', scalar @missing) : ', the whole deck');

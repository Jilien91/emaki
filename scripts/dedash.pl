use strict;
use warnings;
use utf8;

# One-off: replace the em dashes in mnemonic and notes prose with ordinary
# punctuation. Runs over the raw batch files and data/kanji.json as plain UTF-8
# text rather than decoding the JSON, so the hand formatting survives; an em
# dash only ever appears inside a string value, never in JSON syntax.
#
# The dash is doing one of two jobs, and they want different punctuation:
#
#   independent clause after it  ->  full stop, and capitalise
#     "Spoken down the ranks, never up. Kimmy, come here."
#   verbless appositive after it ->  comma
#     "A pictograph, a figure walking, seen from the side."
#
# Guessing wrong in the second direction is what produces comma splices, so
# the test is deliberately biased toward the full stop: the segment following
# the dash counts as a clause if it contains any finite verb at all before the
# next sentence boundary. Whatever this still gets wrong is fixed by hand from
# the review dump afterwards.

binmode(STDOUT, ":encoding(UTF-8)");

my @FINITE = qw(
  is isn't are aren't was wasn't were weren't am
  has hasn't have haven't had hadn't
  does doesn't do don't did didn't
  will won't would wouldn't can can't could couldn't
  should shouldn't might must may
  goes go went comes come came gets get got gives give gave
  takes take took makes make made puts put keeps keep kept
  means meant decides decide decided tells tell told
  says say said knows know knew needs need wants want
  looks look feels feel seems seem becomes become
  turns turn holds hold leaves leave opens open shuts shut
  stands stand sits sit runs run lands land works work
  covers cover stretches stretch carries carry counts count
  sounds sound reads read writes write hangs hang falls fall
  stays stay lives live dies die
);
my %FINITE = map { $_ => 1 } @FINITE;

# Contractions of "is"/"has"/"are"/"have"/"will" attached to a subject.
my $CONTRACTED = qr/\w+'(?:s|re|ve|ll|d)\b/;

sub looks_like_clause {
    my ($seg) = @_;
    return 1 if $seg =~ $CONTRACTED;
    for my $w ($seg =~ /([A-Za-z']+)/g) {
        return 1 if $FINITE{lc $w};
    }
    # regular past tense / third person that isn't in the list
    return 1 if $seg =~ /\b\w{3,}(?:ed|s)\b\s+(?:it|them|him|her|you|me|us)\b/;
    return 0;
}

sub fix {
    my ($text) = @_;
    my $n = 0;
    $text =~ s{
        \s*\x{2014}\s*
        ( [^"]*? )                 # the rest of this JSON string value
        (?= [.!?:;] | \\" | " )    # up to a sentence end or the closing quote
    }{
        my $seg = $1;
        $n++;
        my $first = $seg =~ /^(\S+)/ ? $1 : '';
        if ($first =~ /^[A-Z]/ || looks_like_clause($seg)) {
            my $up = $seg;
            $up =~ s/^([a-z])/\u$1/;
            ". $up";
        } else {
            ", $seg";
        }
    }gex;
    return ($text, $n);
}

my @files = (glob('raw/*_with_mnemonics.json'), 'data/kanji.json');
my $total = 0;
for my $path (@files) {
    open(my $in, '<:encoding(UTF-8)', $path) or die "read $path: $!";
    local $/;
    my $text = <$in>;
    close $in;
    my ($out, $n) = fix($text);
    next unless $n;
    open(my $fh, '>:encoding(UTF-8)', $path) or die "write $path: $!";
    print $fh $out;
    close $fh;
    $total += $n;
}
print "replaced $total\n";

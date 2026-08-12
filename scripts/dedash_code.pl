use strict;
use warnings;
use utf8;

# Same rule as scripts/dedash.pl, pointed at the source files instead of the
# deck: full stop where an independent clause follows the dash, comma where a
# verbless appositive does. An em dash is never valid syntax in any of these
# languages, so every occurrence is inside a comment or a string literal and a
# text pass is safe. The segment is read only as far as the end of the line, so
# nothing reaches across a template literal boundary.

binmode(STDOUT, ":encoding(UTF-8)");

my %FINITE = map { $_ => 1 } qw(
  is are was were am has have had does do did will would can could should
  might must may goes go went comes come came gets get got gives give gave
  takes take took makes make made puts put keeps keep kept means meant
  decides decide tells tell told says say said knows know needs need wants
  want looks look feels feel seems seem becomes become turns turn holds hold
  leaves leave opens open shuts shut stands stand sits sit runs run lands
  land works work covers cover counts count sounds sound reads read writes
  write hangs hang falls fall stays stay lives live appears appear happens
  happen carries carry marks mark shows show costs cost fits fit lets let
  arrives arrive persists persist
);

sub clausey {
    my ($s) = @_;
    return 1 if $s =~ /\w+'(?:s|re|ve|ll|d)\b/;
    for my $w ($s =~ /([A-Za-z]+)/g) { return 1 if $FINITE{lc $w} }
    return 0;
}

my @files = qw(
  app.js sync.js index.html style.css
  scripts/merge.pl scripts/serve.ps1 supabase/schema.sql
);

my $total = 0;
for my $path (@files) {
    next unless -f $path;
    open(my $in, '<:encoding(UTF-8)', $path) or die "read $path: $!";
    local $/;
    my $text = <$in>;
    close $in;

    my $n = 0;
    $text =~ s{
        [ ]*\x{2014}[ ]*
        ( [^\n]*? )
        (?= [.!?;:,]  | \$\{ | ` | ' | " | <br> | \n )
    }{
        my $seg = $1;
        $n++;
        if ($seg =~ /^[A-Z]/ || clausey($seg)) {
            my $up = $seg;
            $up =~ s/^([a-z])/\u$1/;
            ". $up";
        } else {
            ", $seg";
        }
    }gex;

    next unless $n;
    open(my $fh, '>:encoding(UTF-8)', $path) or die "write $path: $!";
    print $fh $text;
    close $fh;
    printf("%-26s %d\n", $path, $n);
    $total += $n;
}
print "replaced $total\n";

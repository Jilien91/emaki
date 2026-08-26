use strict;
use warnings;
use Digest::SHA qw(sha1_hex);

# Stamps style.css, app.js and sync.js in index.html with a query string derived
# from their contents, so a changed file is a changed URL.
#
# This exists because of a real bug, and the bug is worth stating plainly: the
# emblem on the week strip is drawn by app.js and coloured by style.css, and one
# release changed both — app.js started emitting a filled path where it used to
# emit stroked ones, and style.css switched from `stroke` to `fill` to match.
# Neither half works with the other's. A phone that had style.css cached from
# before the change fetched the new app.js and drew the emblem as a hairline
# outline: pale, wrong, and only on that device, while the desktop that happened
# to fetch both was fine. It cost most of an evening to find, because every
# instinct says "it renders differently on iOS" means an iOS rendering problem.
#
# The site has no build step on purpose, so there is nothing that would do this
# as a side effect. Run it before committing a change to any of the three:
#
#     perl scripts/stamp-assets.pl
#
# It rewrites index.html in place and says what it changed. Committing the
# result is the point — the stamp has to be in the deployed HTML.
#
# Content hash rather than a version number or a timestamp: the URL then changes
# exactly when the file does, so an unrelated commit does not force everyone to
# re-download, and there is no counter to remember to bump.

my $html = 'index.html';
my @assets = qw(style.css sync.js app.js);

my $src = do { open my $fh, '<:encoding(UTF-8)', $html or die "$html: $!\n"; local $/; <$fh> };
my $before = $src;

for my $asset (@assets) {
    my $bytes = do { open my $fh, '<:raw', $asset or die "$asset: $!\n"; local $/; <$fh> };
    my $stamp = substr sha1_hex($bytes), 0, 8;

    # Matches the asset with or without an existing stamp, so re-running is safe.
    my $quoted = quotemeta $asset;
    my $n = ($src =~ s{(href|src)="$quoted(?:\?v=[0-9a-f]+)?"}{$1="$asset?v=$stamp"}g);

    die "$asset is not referenced in $html\n" unless $n;
    printf "%-12s %s%s\n", $asset, $stamp, $n > 1 ? "  ($n references)" : '';
}

if ($src eq $before) {
    print "index.html already up to date\n";
} else {
    open my $out, '>:encoding(UTF-8)', $html or die "$html: $!\n";
    print $out $src;
    print "index.html rewritten\n";
}

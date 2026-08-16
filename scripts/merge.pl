use strict;
use warnings;
use JSON::PP;

# Rebuilds data/vocab.json from raw/kaishi_1500_full.json plus every
# raw/*_with_mnemonics.json batch file. Run from the project root:
#   perl scripts/merge.pl
# Add a new batch (e.g. raw/kaishi_batch2_with_mnemonics.json) and rerun
# to layer in more mnemonics as they're written.

my $json = JSON::PP->new->utf8(0);

# The upstream deck is exported from Anki HTML, so some fields carry literal
# "&nbsp;" entities (310 of them across 183 words). Rendered into innerHTML
# they look like normal spaces, but answer grading compares against the raw
# string, so "to&nbsp;believe" could never be matched by typing "to believe".
# Normalize to plain spaces at build time.
sub clean_text {
    my ($s) = @_;
    return $s unless defined $s && !ref $s;
    $s =~ s/&nbsp;/ /g;
    $s =~ s/\x{00A0}/ /g;
    $s =~ s/[ \t]+/ /g;
    $s =~ s/^\s+|\s+$//g;
    return $s;
}

sub read_json {
    my ($path) = @_;
    open(my $fh, '<:encoding(UTF-8)', $path) or die "can't read $path: $!";
    local $/;
    my $raw = <$fh>;
    close $fh;
    my $data = $json->decode($raw);
    # Clean on read so batch files and the full deck are normalized the same
    # way before entries are matched up by word+reading+meaning.
    for my $entry (@$data) {
        $entry->{$_} = clean_text($entry->{$_}) for keys %$entry;
    }
    return $data;
}

my $full = read_json('raw/kaishi_1500_full.json');

my @merged;
for my $i (0 .. $#$full) {
    my $entry = { %{ $full->[$i] } };
    $entry->{id} = $i + 1;
    $entry->{mnemonic} = "";
    $entry->{notes} = "";
    push @merged, $entry;
}

# key entries by word+reading+meaning so homophones with distinct
# meanings (e.g. 聞く "to hear" vs 聞く "to ask") don't collide
my %by_key;
for my $entry (@merged) {
    my $key = join("\x1f", $entry->{word}, $entry->{reading}, $entry->{meaning});
    $by_key{$key} = $entry;
}

# Later batches must overwrite earlier ones for the same word, that's how a
# rewrite ships. A plain lexicographic sort breaks that once batch numbers hit
# double digits: "batch13_rewrites" sorts before "batch1", so a rewrite of a
# word first written in batch8 was silently undone by batch8 running after it.
# Sort on the batch number instead, with a rewrite applying after the plain
# batch of the same number, and anything unnumbered last.
sub batch_order {
    my ($path) = @_;
    my ($n) = $path =~ /batch(\d+)/;
    return (defined $n ? $n : 1e9, ($path =~ /rewrites/ ? 1 : 0), $path);
}
my @batch_files = sort {
    my @a = batch_order($a);
    my @b = batch_order($b);
    $a[0] <=> $b[0] || $a[1] <=> $b[1] || $a[2] cmp $b[2]
} glob('raw/*_with_mnemonics.json');
for my $file (@batch_files) {
    my $batch = read_json($file);
    my $applied = 0;
    for my $b (@$batch) {
        my $key = join("\x1f", $b->{word}, $b->{reading}, $b->{meaning});
        my $entry = $by_key{$key};
        if ($entry) {
            $entry->{mnemonic} = $b->{mnemonic} // "";
            $entry->{notes} = $b->{notes} // "";
            $applied++;
        } else {
            warn "no match in full deck for $b->{word} ($b->{reading}) from $file\n";
        }
    }
    print "$file: applied $applied/" . scalar(@$batch) . " entries\n";
}

# canonical(1) sorts the keys of every entry. Without it JSON::PP writes them in
# Perl's hash order, which is reseeded per process, so a rerun that changed one
# card still reshuffled the keys of all 1500 and every batch commit carried an
# 8,000 line diff with no content in it. Sorted output makes the diff the batch.
my $out_json = JSON::PP->new->utf8(0)->pretty->canonical(1)->encode(\@merged);
open(my $out, '>:encoding(UTF-8)', 'data/vocab.json') or die $!;
print $out $out_json;
close $out;

my $with_mnemonics = grep { $_->{mnemonic} } @merged;
print "wrote data/vocab.json: " . scalar(@merged) . " words total, $with_mnemonics with mnemonics\n";

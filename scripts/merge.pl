use strict;
use warnings;
use JSON::PP;

# Rebuilds data/vocab.json from raw/kaishi_1500_full.json plus every
# raw/*_with_mnemonics.json batch file. Run from the project root:
#   perl scripts/merge.pl
# Add a new batch (e.g. raw/kaishi_batch2_with_mnemonics.json) and rerun
# to layer in more mnemonics as they're written.

my $json = JSON::PP->new->utf8(0);

sub read_json {
    my ($path) = @_;
    open(my $fh, '<:encoding(UTF-8)', $path) or die "can't read $path: $!";
    local $/;
    my $raw = <$fh>;
    close $fh;
    return $json->decode($raw);
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

my @batch_files = sort glob('raw/*_with_mnemonics.json');
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

my $out_json = JSON::PP->new->utf8(0)->pretty->canonical(0)->encode(\@merged);
open(my $out, '>:encoding(UTF-8)', 'data/vocab.json') or die $!;
print $out $out_json;
close $out;

my $with_mnemonics = grep { $_->{mnemonic} } @merged;
print "wrote data/vocab.json: " . scalar(@merged) . " words total, $with_mnemonics with mnemonics\n";

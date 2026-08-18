use strict;
use warnings;
use utf8;
use JSON::PP;
binmode(STDOUT, ':encoding(UTF-8)');

# Checks the usage notes in data/vocab.json against the upstream deck's own
# Notes field, run from the project root:
#
#   perl scripts/check-notes.pl
#
# Why this exists. Kaishi carries a Notes field on 56 of its 1,500 cards.
# raw/kaishi_1500_full.json holds six fields and nothing else, so from inside
# this repository that field is invisible, and ten of the first 125 notes here
# turned out to be the upstream note copied or lightly reworded before anybody
# opened the two side by side. The README promises that only word, reading,
# meaning, sentence, sentence meaning and frequency are taken from Kaishi, and
# a borrowed note makes that false.
#
# It needs an Anki export to compare against, which is not in the repository
# and should not be: it carries audio filenames, images and pitch accent that
# this project deliberately does not ship, and .gitignore keeps it out. To
# produce one, in Anki: File -> Export, format "Notes in Plain Text (.txt)",
# include the Kaishi deck, and save it here as Kaishi*.txt. Without it the
# script says so and exits clean rather than failing.
#
# Facts are not ownable and belong on the card: 日本 really does take both
# にほん and にっぽん. Sentences are. So a shared run of Japanese readings is
# expected and fine, and a shared run of English prose is not.

my ($export) = sort glob('Kaishi*.txt');
unless ($export && -e $export) {
  print "no upstream export found (Kaishi*.txt in the project root)\n";
  print "nothing to compare against, skipping. See the header of this file.\n";
  exit 0;
}

# Anki writes tab separated with CSV style quoting: a field holding a tab, a
# newline or a quote is wrapped in quotes and its own quotes doubled.
sub split_row {
  my $line = shift;
  my (@out, $cur, $inq);
  ($cur, $inq) = ('', 0);
  my @ch = split //, $line;
  for (my $i = 0; $i <= $#ch; $i++) {
    my $c = $ch[$i];
    if ($inq) {
      if ($c eq '"') {
        if (defined $ch[$i+1] && $ch[$i+1] eq '"') { $cur .= '"'; $i++ }
        else { $inq = 0 }
      } else { $cur .= $c }
    } else {
      if    ($c eq '"' && $cur eq '') { $inq = 1 }
      elsif ($c eq "\t") { push @out, $cur; $cur = '' }
      else  { $cur .= $c }
    }
  }
  push @out, $cur;
  return @out;
}

sub clean {
  my $s = shift // '';
  $s =~ s/<br\s*\/?>/ /gi;   # Anki separates note lines with <br>
  $s =~ s/<[^>]+>/ /g;
  $s =~ s/&nbsp;/ /g;
  $s =~ s/&amp;/&/g;
  $s =~ s/\s+/ /g;
  $s =~ s/^\s+|\s+$//g;
  return $s;
}

# Longest run of shared tokens, the same measure verify.pl uses on kanji notes.
# CJK splits per character so that a shared reading shows up honestly rather
# than counting as one token.
sub toks {
  my $s = lc shift;
  $s =~ s/[^\w\s\x{2E80}-\x{9FFF}]/ /g;
  return grep { length }
         map { /[\x{2E80}-\x{9FFF}]/ ? split(//, $_) : $_ } split /\s+/, $s;
}
sub longest_run {
  my @a = toks(shift);
  my @b = toks(shift);
  my (@prev, $best);
  $best = 0;
  for my $i (0 .. $#a) {
    my @cur;
    for my $j (0 .. $#b) {
      if ($a[$i] eq $b[$j]) {
        $cur[$j] = ($j ? ($prev[$j-1] || 0) : 0) + 1;
        $best = $cur[$j] if $cur[$j] > $best;
      } else { $cur[$j] = 0 }
    }
    @prev = @cur;
  }
  return $best;
}

open(my $fh, '<:encoding(UTF-8)', $export) or die "can't read $export: $!";
my (%theirs, $rows, $withNotes);
while (my $line = <$fh>) {
  chomp $line;
  next if $line =~ /^#/ || $line eq '';
  my @f = split_row($line);
  next unless @f >= 10;
  $rows++;
  my $note = clean($f[9]);
  next unless length $note;
  $withNotes++;
  $theirs{ $f[0] . "\x1f" . $f[1] } = $note;
  $theirs{ $f[0] } = $note unless exists $theirs{ $f[0] };
}
close $fh;
printf "%s: %d rows, %d with a Notes field\n\n", $export, $rows, $withNotes;

my $json = JSON::PP->new->utf8(0);
open(my $v, '<:encoding(UTF-8)', 'data/vocab.json')
  or die "can't read data/vocab.json: $!\nRun from the project root.\n";
local $/;
my $vocab = $json->decode(<$v>);
close $v;

my (@bad, @borderline, $ours);
for my $e (@$vocab) {
  my $mine = clean($e->{notes} // '');
  next unless length $mine;
  $ours++;
  my $up = $theirs{ $e->{word} . "\x1f" . $e->{reading} } // $theirs{ $e->{word} };
  next unless defined $up;
  my $run = longest_run($mine, $up);
  my $tt  = scalar toks($up);
  my $rec = { id=>$e->{id}, word=>$e->{word}, run=>$run, tt=>$tt, mine=>$mine, up=>$up };
  if    ($mine eq $up || $run >= $tt * 0.6 || $run >= 8) { push @bad, $rec }
  elsif ($run >= 4)                                      { push @borderline, $rec }
}

printf "notes here: %d\n", $ours;
printf "  copied or closely derived : %d\n", scalar @bad;
printf "  short shared run, 4 to 7  : %d\n", scalar @borderline;

for my $r (sort { $b->{run} <=> $a->{run} } @borderline) {
  printf "\nshort run (%d of their %d tokens), check it is only the readings:\n  #%d %s\n  theirs: %s\n  ours  : %s\n",
    $r->{run}, $r->{tt}, $r->{id}, $r->{word}, $r->{up}, $r->{mine};
}

if (@bad) {
  print "\n", '=' x 70, "\nREWRITE THESE\n", '=' x 70, "\n";
  for my $r (sort { $b->{run} <=> $a->{run} } @bad) {
    printf "#%d %s   run of %d against their %d tokens\n  theirs: %s\n  ours  : %s\n\n",
      $r->{id}, $r->{word}, $r->{run}, $r->{tt}, $r->{up}, $r->{mine};
  }
  print "Keep the fact, change the sentence. See the header of this file.\n";
  exit 1;
}

print "\nno borrowed notes.\n";
exit 0;

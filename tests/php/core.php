<?php
require __DIR__.'/vendor/autoload.php';
ob_start();
$f = FirePHP::getInstance(true);
class Foo { public $a = 1; protected $b = 'x'; private $c = [1,2]; static $s = 'st'; public $self; }
$o = new Foo; $o->self = $o;
$f->log('Hello World');
$f->info(['a'=>1,'b'=>[true,null,1.5]], 'Info label');
$f->warn('Cuidado ñandú €');
$f->error('Error msg');
$f->group('Grupo 1', ['Collapsed'=>true, 'Color'=>'#FF00FF']);
$f->log($o, 'Objeto');
$f->groupEnd();
$f->table('Tabla', [['Col1','Col2'],['a','b'],['c',['x'=>1]]]);
$f->trace('Traza');
$f->dump('miDump', ['k'=>'v']);
try { throw new RuntimeException('Boom'); } catch (Exception $e) { $f->error($e); }
$f->log(str_repeat('LARGO-', 3000), 'Mensaje largo');
echo "ok";
